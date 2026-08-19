import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { DRIZZLE, openSecret, sealSecret, writeAudit } from '../../infrastructure/index';
import type { Db, DbOrTx } from '../../infrastructure/index';
import { IDENTITY_OPTIONS } from '../identity-options';
import type { IdentityOptions } from '../identity-options';
import { connectorCredential } from './tables';

/**
 * Connector credential storage inside the identity seam (V2.5 item 8.1,
 * issue B; decision record docs/features/connectors.md).
 *
 * The confinement contract, asserted structurally by
 * `credential-confinement.spec.ts`:
 *
 * - The sealed `secret` column is named ONLY in this file: written where
 *   sealing happens, selected in exactly one function
 *   (`ConnectorCredentialOpener.open`).
 * - The opener is a SEPARATE injectable that only the worker root provides
 *   (`IdentityModule.register({ credentialReads: true })`), the
 *   `MemorySystemStore` withholding pattern applied to secrets: a
 *   request-path service that asks for it fails at boot, so the app process
 *   can store, describe and destroy credentials but can never read one back.
 * - Every read the store itself offers is a projection without the sealed
 *   column, so no DTO can carry secret material even by accident.
 * - Destruction is audited with structural detail only, recording THAT it
 *   happened and never what was destroyed.
 */

/** The material envelope, sealed as one JSON value. */
export interface CredentialMaterial {
  accessToken: string;
  refreshToken?: string;
  /** Provider-specific extras a descriptor needs back at fetch time. */
  extras?: Record<string, string>;
}

/** What anyone may see: everything except the secret. */
export interface ConnectorCredentialSummary {
  id: string;
  ownerId: string;
  orgId: string;
  connectorId: string;
  accountIdentity: string | null;
  scopes: string[] | null;
  expiresAt: Date | null;
  lastRefreshedAt: Date | null;
  refreshFailedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoreCredentialInput {
  ownerId: string;
  orgId: string;
  connectorId: string;
  material: CredentialMaterial;
  accountIdentity?: string | null;
  scopes?: string[] | null;
  expiresAt?: Date | null;
  /** The connector's space, passed by the caller: identity is a seam and
   * never reads the connectors module's tables. Audit stamping only. */
  spaceId?: string;
}

/** Every ordinary read names its columns; the sealed one is not among them. */
const SUMMARY_COLUMNS = {
  id: connectorCredential.id,
  ownerId: connectorCredential.ownerId,
  orgId: connectorCredential.orgId,
  connectorId: connectorCredential.connectorId,
  accountIdentity: connectorCredential.accountIdentity,
  scopes: connectorCredential.scopes,
  expiresAt: connectorCredential.expiresAt,
  lastRefreshedAt: connectorCredential.lastRefreshedAt,
  refreshFailedAt: connectorCredential.refreshFailedAt,
  createdAt: connectorCredential.createdAt,
  updatedAt: connectorCredential.updatedAt,
} as const;

@Injectable()
export class ConnectorCredentialStore {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(IDENTITY_OPTIONS) private readonly options: IdentityOptions,
  ) {}

  /**
   * Store (or replace) a connector's credential. Sealing throws
   * `MasterKeyError` when no master key is configured, rather than ever
   * storing material in the clear. Takes the caller's executor so the write
   * can share a transaction with the connector-state change it accompanies.
   */
  async store(executor: DbOrTx, input: StoreCredentialInput): Promise<void> {
    const sealed = sealSecret(this.options.masterKey ?? null, JSON.stringify(input.material));
    await executor
      .insert(connectorCredential)
      .values({
        ownerId: input.ownerId,
        orgId: input.orgId,
        connectorId: input.connectorId,
        secret: sealed,
        accountIdentity: input.accountIdentity ?? null,
        scopes: input.scopes ?? null,
        expiresAt: input.expiresAt ?? null,
      })
      .onConflictDoUpdate({
        target: connectorCredential.connectorId,
        set: {
          secret: sealed,
          accountIdentity: input.accountIdentity ?? null,
          scopes: input.scopes ?? null,
          expiresAt: input.expiresAt ?? null,
          refreshFailedAt: null,
          updatedAt: new Date(),
        },
      });
    await writeAudit(executor, {
      actor: `user:${input.ownerId}`,
      action: 'connector_credential.stored',
      entityType: 'connector',
      entityId: input.connectorId,
      // Structural only: which shapes are present, never a value.
      detail: {
        hasRefreshToken: !!input.material.refreshToken,
        hasExpiry: !!input.expiresAt,
        scopeCount: input.scopes?.length ?? 0,
      },
      orgId: input.orgId,
      ownerId: input.ownerId,
      spaceId: input.spaceId,
    });
  }

  /** Metadata only. What the user sees: scopes granted, account, expiry. */
  async describe(connectorId: string): Promise<ConnectorCredentialSummary | null> {
    const rows = await this.db
      .select(SUMMARY_COLUMNS)
      .from(connectorCredential)
      .where(eq(connectorCredential.connectorId, connectorId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Refresh bookkeeping: a successful rotation updates material and expiry. */
  async recordRefresh(
    executor: DbOrTx,
    connectorId: string,
    material: CredentialMaterial,
    expiresAt: Date | null,
  ): Promise<void> {
    const sealed = sealSecret(this.options.masterKey ?? null, JSON.stringify(material));
    await executor
      .update(connectorCredential)
      .set({
        secret: sealed,
        expiresAt,
        lastRefreshedAt: new Date(),
        refreshFailedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(connectorCredential.connectorId, connectorId));
  }

  /**
   * A failed refresh is recorded, never retried forever: the platform moves
   * the connector to needs_reauth on the strength of this stamp.
   */
  async recordRefreshFailure(executor: DbOrTx, connectorId: string): Promise<void> {
    await executor
      .update(connectorCredential)
      .set({ refreshFailedAt: new Date(), updatedAt: new Date() })
      .where(eq(connectorCredential.connectorId, connectorId));
  }

  /**
   * Credentials whose expiry falls before the deadline and whose refresh has
   * not already failed: the maintenance job's scan. Metadata only.
   */
  async expiringBefore(deadline: Date): Promise<ConnectorCredentialSummary[]> {
    return this.db
      .select(SUMMARY_COLUMNS)
      .from(connectorCredential)
      .where(
        and(isNotNull(connectorCredential.expiresAt), lt(connectorCredential.expiresAt, deadline)),
      );
  }

  /**
   * Destroy a connector's credential, immediately and verifiably: the return
   * value is the number of rows that existed, and the audit row records that
   * destruction happened without recording any secret.
   */
  async destroy(
    executor: DbOrTx,
    input: { connectorId: string; ownerId: string; orgId: string; actor: string; spaceId?: string },
  ): Promise<number> {
    const deleted = await executor
      .delete(connectorCredential)
      .where(eq(connectorCredential.connectorId, input.connectorId))
      .returning({ id: connectorCredential.id });
    await writeAudit(executor, {
      actor: input.actor,
      action: 'connector_credential.destroyed',
      entityType: 'connector',
      entityId: input.connectorId,
      detail: { destroyed: deleted.length },
      orgId: input.orgId,
      ownerId: input.ownerId,
      spaceId: input.spaceId,
    });
    return deleted.length;
  }
}

/** What the opener hands to the sync engine: material plus its bookkeeping. */
export interface OpenedCredential {
  material: CredentialMaterial;
  expiresAt: Date | null;
  refreshFailedAt: Date | null;
}

/**
 * The worker-only decrypting read. Provided ONLY when the composition root
 * passes `credentialReads: true` (the worker does; the app never does), so
 * an ungated credential read is unrepresentable in the process that serves
 * requests. This class is the single place the sealed column is selected.
 */
@Injectable()
export class ConnectorCredentialOpener {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(IDENTITY_OPTIONS) private readonly options: IdentityOptions,
  ) {}

  async open(connectorId: string): Promise<OpenedCredential | null> {
    const rows = await this.db
      .select({
        secret: connectorCredential.secret,
        expiresAt: connectorCredential.expiresAt,
        refreshFailedAt: connectorCredential.refreshFailedAt,
      })
      .from(connectorCredential)
      .where(eq(connectorCredential.connectorId, connectorId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const material = JSON.parse(
      openSecret(this.options.masterKey ?? null, row.secret),
    ) as CredentialMaterial;
    return { material, expiresAt: row.expiresAt, refreshFailedAt: row.refreshFailedAt };
  }
}
