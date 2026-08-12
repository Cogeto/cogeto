import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  DRIZZLE,
  parseOrBadRequest,
  withTransactionalEnqueue,
  writeAudit,
} from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { BearerAuthGuard, ConnectorCredentialStore } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { ProjectService } from '../projects/index';
import { ConnectorRegistry } from './connector-registry';
import { ConnectorStore } from './persistence/connector-store';
import { ConnectorItemLedger } from './persistence/item-ledger';
import { CONNECTOR_PRESENCE_JOB_TYPE, CONNECTOR_SYNC_JOB_TYPE } from './connector-jobs';
import { SYNCABLE_STATES } from './domain/lifecycle';
import type { ConnectorRow } from './persistence/tables';

/**
 * The owner's connector surface (V2.5 item 8.1): configure, authorise,
 * select sub-scopes, confirm the bounded backfill, pause, remove, inspect.
 * Everything here is metadata; credential material travels one way (in) and
 * the webhook signing secret is returned exactly once at rotation.
 */

const createSchema = z.object({
  kind: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
});

const credentialsSchema = z.object({
  accessToken: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192).optional(),
  extras: z.record(z.string(), z.string().max(8192)).optional(),
  accountIdentity: z.string().max(500).optional(),
  scopes: z.array(z.string().max(200)).max(100).optional(),
  expiresAt: z.string().datetime().optional(),
});

const settingsSchema = z.object({
  backfillDays: z.number().int().positive().max(3650).optional(),
  backfillItemCap: z.number().int().positive().max(100_000).optional(),
  /** The user's EXPLICIT everything; never a default (issue C4). */
  backfillAll: z.boolean().optional(),
  dailyItemCap: z.number().int().positive().max(100_000).optional(),
});

const subScopeSchema = z.object({
  selected: z.boolean().optional(),
  itemCap: z.number().int().positive().max(100_000).nullable().optional(),
  /** Per-scope choices (V2.5 item 8.2): today the attachments toggle. */
  attachments: z.boolean().optional(),
  /** The project everything this scope ingests lands in (V2.5 item 8.3);
   * null unassigns. Omitted leaves the assignment untouched. */
  projectId: z.uuid().nullable().optional(),
});

const reingestSchema = z.object({
  naturalKey: z.string().min(1).max(1000),
});

const addSubScopeSchema = z.object({
  key: z.string().min(1).max(500),
  label: z.string().min(1).max(500),
});

@Controller('connectors')
@UseGuards(BearerAuthGuard)
export class ConnectorsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly store: ConnectorStore,
    private readonly registry: ConnectorRegistry,
    private readonly credentials: ConnectorCredentialStore,
    private readonly ledger: ConnectorItemLedger,
    /** Projects (V2.5 item 8.3): a sub-scope can feed one. Optional so a
     * root that registers no projects module serves connectors unchanged. */
    @Optional() private readonly projects?: ProjectService,
  ) {}

  @Get('kinds')
  kinds(): { kinds: string[] } {
    return { kinds: this.registry.kinds() };
  }

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    const rows = await this.store.listForOwner(request.principal.userId);
    return { connectors: rows.map(publicView) };
  }

  @Post()
  async create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const parsed = parseOrBadRequest(createSchema, body);
    if (!this.registry.get(parsed.kind)) {
      throw new BadRequestException(`unknown connector kind '${parsed.kind}'`);
    }
    const row = await this.store.create({
      ownerId: request.principal.userId,
      orgId: request.principal.orgId,
      kind: parsed.kind,
      name: parsed.name,
    });
    return publicView(row);
  }

  @Get(':id')
  async detail(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.store.byIdForOwner(id, request.principal.userId);
    const [credential, subScopes, runs] = await Promise.all([
      this.credentials.describe(row.id),
      this.store.subScopes(row.id),
      this.store.recentSyncRuns(row.id),
    ]);
    const scopeProjects =
      (await this.projects?.projectIdsForRefs(
        request.principal.userId,
        'connector_sub_scope',
        subScopes.map((s) => s.id),
      )) ?? new Map<string, string>();
    return {
      ...publicView(row),
      // What the user is entitled to see about the access they granted:
      // scopes, account, expiry. Never the material itself (issue B3).
      credential: credential
        ? {
            accountIdentity: credential.accountIdentity,
            scopes: credential.scopes,
            expiresAt: credential.expiresAt?.toISOString() ?? null,
            lastRefreshedAt: credential.lastRefreshedAt?.toISOString() ?? null,
            refreshFailed: credential.refreshFailedAt !== null,
          }
        : null,
      subScopes: subScopes.map((s) => ({
        id: s.id,
        // The project this container's items land in (V2.5 item 8.3 issue
        // C1), or null. Organisation, never authorisation.
        projectId: scopeProjects.get(s.id) ?? null,
        key: s.key,
        label: s.label,
        selected: s.selected,
        itemCap: s.itemCap,
        backfillComplete: s.backfillJson?.complete ?? false,
        attachments: s.settingsJson?.attachments ?? false,
        stats: s.statsJson ?? null,
      })),
      syncRuns: runs.map((r) => ({
        id: r.id,
        kind: r.kind,
        state: r.state,
        reason: r.reason,
        counts: r.countsJson ?? null,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
      })),
    };
  }

  /** Store the credential (write-only) and mark the connector authorised. */
  @Post(':id/credentials')
  async storeCredentials(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const row = await this.store.byIdForOwner(id, request.principal.userId);
    const parsed = parseOrBadRequest(credentialsSchema, body);
    await this.db.transaction(async (tx) => {
      await this.credentials.store(tx, {
        ownerId: row.ownerId,
        orgId: row.orgId,
        connectorId: row.id,
        material: {
          accessToken: parsed.accessToken,
          refreshToken: parsed.refreshToken,
          extras: parsed.extras,
        },
        accountIdentity: parsed.accountIdentity ?? null,
        scopes: parsed.scopes ?? null,
        expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
      });
      if (row.state === 'configured' || row.state === 'needs_reauth') {
        await this.store.transition(tx, row, 'authorised', {
          actor: `user:${request.principal.userId}`,
        });
      }
    });
    return { stored: true };
  }

  /** Generate the webhook signing secret; returned ONCE, never again. */
  @Post(':id/webhook-secret')
  async rotateWebhookSecret(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const row = await this.store.byIdForOwner(id, request.principal.userId);
    const descriptor = this.registry.get(row.kind);
    if (!descriptor?.webhook) {
      throw new BadRequestException('this connector kind declares no webhook');
    }
    const secret = await this.store.rotateWebhookSecret(row);
    return { secret };
  }

  @Put(':id/settings')
  async updateSettings(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const row = await this.store.byIdForOwner(id, request.principal.userId);
    const parsed = parseOrBadRequest(settingsSchema, body);
    await this.store.updateSettings(row.id, { ...(row.settingsJson ?? {}), ...parsed });
    return { updated: true };
  }

  @Put(':id/sub-scopes/:key')
  async updateSubScope(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key') key: string,
    @Body() body: unknown,
  ) {
    const row = await this.store.byIdForOwner(id, request.principal.userId);
    const parsed = parseOrBadRequest(subScopeSchema, body);
    await this.store.setSubScopeSelection(row, key, {
      selected: parsed.selected,
      itemCap: parsed.itemCap,
      ...(parsed.attachments === undefined
        ? {}
        : { settingsJson: { attachments: parsed.attachments } }),
    });
    // The project this container feeds (V2.5 item 8.3 issue C1). Applies to
    // what the scope ingests NEXT; what it already ingested keeps the project
    // it was recorded under, because rewriting history silently is the
    // surprising behaviour.
    if (parsed.projectId !== undefined && this.projects) {
      const scope = await this.store.subScopeByKey(row.id, key);
      if (scope) {
        await this.projects.assign(
          request.principal,
          { kind: 'connector_sub_scope', refType: 'connector_sub_scope', refId: scope.id },
          parsed.projectId,
        );
      }
    }
    return { updated: true };
  }

  /**
   * A CUSTOM sub-scope for a container discovery cannot enumerate (V2.5
   * item 8.2, issue B1: a page and its descendants). The descriptor's key
   * grammar decides what is acceptable; upstream validation happens on the
   * next sync, which fails the scope with a named reason rather than here,
   * because the app holds no upstream credential to check with.
   */
  @Post(':id/sub-scopes')
  async addSubScope(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const row = await this.store.byIdForOwner(id, request.principal.userId);
    const parsed = parseOrBadRequest(addSubScopeSchema, body);
    const descriptor = this.registry.get(row.kind);
    if (!descriptor?.acceptSubScopeKey) {
      throw new BadRequestException('this connector kind accepts no custom sub-scopes');
    }
    if (!descriptor.acceptSubScopeKey(parsed.key)) {
      throw new BadRequestException('the key does not match this connector sub-scope form');
    }
    await this.store.addSubScope(row, parsed.key, parsed.label);
    return { added: true };
  }

  /** The "deleted by you" list (issue #518): items the user erased, which a
   * sync will never bring back on its own. Identifiers and dates only. */
  @Get(':id/erased-items')
  async erasedItems(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.store.byIdForOwner(id, request.principal.userId);
    const items = await this.ledger.erasedItems(row.id);
    return {
      items: items.map((item) => ({
        naturalKey: item.naturalKey,
        lastSeenAt: item.lastSeenAt.toISOString(),
        erasedAt: item.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * The explicit override of erased-stays-erased (issue #518): the user, per
   * item, chooses to ingest it again. The one ledger row is released inside
   * the same transaction that audits the choice and enqueues the sync, so
   * the item returns as a BRAND-NEW source through the normal path; the
   * original deletion stays deleted under its receipt.
   */
  @Post(':id/erased-items/reingest')
  async reingestErased(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const row = await this.store.byIdForOwner(id, request.principal.userId);
    const parsed = parseOrBadRequest(reingestSchema, body);
    if (!SYNCABLE_STATES.includes(row.state)) {
      throw new BadRequestException(`a ${row.state} connector cannot sync`);
    }
    let released = false;
    await this.db.transaction(async (tx) => {
      released = await this.ledger.releaseErased(tx, row.id, parsed.naturalKey);
      if (!released) return;
      await writeAudit(tx, {
        actor: `user:${request.principal.userId}`,
        action: 'connector.item_reingest_allowed',
        entityType: 'connector',
        entityId: row.id,
        detail: { naturalKey: parsed.naturalKey },
        orgId: row.orgId,
        ownerId: row.ownerId,
      });
      await withTransactionalEnqueue(
        tx,
        { type: 'connector.sync_requested', payload: { connector_id: row.id } },
        {
          type: CONNECTOR_SYNC_JOB_TYPE,
          payload: { source_type: 'connector', source_id: row.id },
          principalId: row.ownerId,
        },
      );
    });
    if (!released) throw new NotFoundException('no such erased item');
    return { released: true };
  }

  /** Trigger a presence sweep (issue C5): reconcile the ledger against what
   * the upstream still lists, on demand. */
  @Post(':id/presence')
  async presence(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.store.byIdForOwner(id, request.principal.userId);
    const descriptor = this.registry.get(row.kind);
    if (!descriptor?.listKeys) {
      throw new BadRequestException('this connector kind cannot list upstream presence');
    }
    if (!SYNCABLE_STATES.includes(row.state)) {
      throw new BadRequestException(`a ${row.state} connector cannot sweep`);
    }
    await this.db.transaction(async (tx) => {
      await withTransactionalEnqueue(
        tx,
        { type: 'connector.presence_requested', payload: { connector_id: row.id } },
        {
          type: CONNECTOR_PRESENCE_JOB_TYPE,
          payload: { source_type: 'connector', source_id: row.id },
          principalId: row.ownerId,
        },
      );
    });
    return { enqueued: true };
  }

  /** Trigger a sync pass (also how discovery is refreshed). */
  @Post(':id/sync')
  async sync(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.store.byIdForOwner(id, request.principal.userId);
    if (!SYNCABLE_STATES.includes(row.state)) {
      throw new BadRequestException(`a ${row.state} connector cannot sync`);
    }
    await this.db.transaction(async (tx) => {
      await withTransactionalEnqueue(
        tx,
        { type: 'connector.sync_requested', payload: { connector_id: row.id } },
        {
          type: CONNECTOR_SYNC_JOB_TYPE,
          payload: { source_type: 'connector', source_id: row.id },
          principalId: row.ownerId,
        },
      );
    });
    return { enqueued: true };
  }

  @Post(':id/disable')
  async disable(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.store.byIdForOwner(id, request.principal.userId);
    await this.store.transition(this.db, row, 'disabled', {
      actor: `user:${request.principal.userId}`,
    });
    return { state: 'disabled' };
  }

  @Post(':id/enable')
  async enable(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.store.byIdForOwner(id, request.principal.userId);
    const credential = await this.credentials.describe(row.id);
    if (!credential) throw new BadRequestException('authorise the connector first');
    await this.store.transition(this.db, row, 'authorised', {
      actor: `user:${request.principal.userId}`,
    });
    return { state: 'authorised' };
  }

  /**
   * Removal is complete (issue A2): the credential is destroyed immediately
   * and verifiably in the same transaction, sync state is cleared, and
   * already-ingested sources remain as sources with their provenance
   * intact, because deleting a connector must not silently erase memory.
   */
  @Delete(':id')
  async remove(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.store.byIdForOwner(id, request.principal.userId);
    const actor = `user:${request.principal.userId}`;
    // Removal destroys credentials and sync state; the SOURCES it produced
    // remain with their provenance intact (V2.5 item 8.1), and they keep
    // their project, because they are still that client's documents. What
    // goes is the SCOPE assignments, which now point at nothing (item 8.3).
    const subScopeIds = (await this.store.subScopes(row.id)).map((scope) => scope.id);
    await this.db.transaction(async (tx) => {
      await this.credentials.destroy(tx, {
        connectorId: row.id,
        ownerId: row.ownerId,
        orgId: row.orgId,
        actor,
      });
      await this.store.remove(tx, row, actor);
    });
    await this.projects?.releaseRefs(row.ownerId, 'connector_sub_scope', subScopeIds);
    const survivingCredential = await this.credentials.describe(row.id);
    return { removed: true, credentialDestroyed: survivingCredential === null };
  }
}

function publicView(row: ConnectorRow) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    state: row.state,
    statusReason: row.statusReason,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    settings: row.settingsJson ?? {},
    webhookExpiresAt: row.webhookExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
