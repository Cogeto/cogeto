import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { resolveSpaceId } from '@cogeto/shared';
import type {
  AddEmailAliasRequest,
  AddEmailAllowlistEntryRequest,
  EmailAliasDto,
  EmailAllowlistEntryDto,
  EmailRefusalDto,
  Principal,
} from '@cogeto/shared';
import { DRIZZLE, userError, writeAudit } from '../infrastructure/index';
import type { Db, DbOrTx } from '../infrastructure/index';
import { emailAlias, emailAllowlist, emailRefusal } from './persistence/tables';
import type { EmailAliasRow, EmailAllowlistRow } from './persistence/tables';
import { normalizeAlias, normalizeAllowlistValue, senderMatchesAllowlist } from './email-parse';
import type { AllowlistEntry } from './email-parse';

/** How many recent refusals the Settings surface shows (one-click allowlisting). */
const RECENT_REFUSALS_LIMIT = 20;

/**
 * Refused mail records hold third-party sender addresses (PII) and, on an
 * internet-facing SMTP port, grow unbounded from unknown senders (/GAP-6).
 * A nightly pass prunes rows older than this window — long enough to remain
 * useful for one-click allowlisting, short enough to bound the retained PII.
 */
export const REFUSAL_RETENTION_DAYS = 30;
export const EMAIL_REFUSAL_RETENTION_JOB_TYPE = 'email_refusal_retention';
/** Daily at 03:50 UTC — after the other nightly passes (worker pins TZ=UTC). */
export const EMAIL_REFUSAL_RETENTION_CRONTAB = `50 3 * * * ${EMAIL_REFUSAL_RETENTION_JOB_TYPE}`;

/**
 * The per-user sender allowlist — personal routing for external senders
 * (rule 2: "senders whose mail I want in MY memory") — plus the
 * metadata-only refusal log. Owned by connectors. The intake consults
 * `ownersMatching` before storing anything; the Settings surface manages
 * entries (audited) and reads recent refusals. Empty allowlists → closed by
 * default: `ownersMatching` returns nobody for every sender.
 */
@Injectable()
export class EmailAllowlistService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Every user whose allowlist matches the sender — each of them receives a
   * copy of the message (rule 2). Empty for an unmatched or
   * unparsable sender (closed by default).
   */
  async ownersMatching(matchedSender: string | null): Promise<string[]> {
    return (await this.routesMatching(matchedSender)).map((route) => route.ownerId);
  }

  /**
   * Every matching owner WITH the matched rule's target space
   * (docs/features/spaces.md section 6c). Per owner the most specific rule
   * wins: an `address` entry outranks a `domain` entry, and the unique index
   * on (owner, kind, value) makes an equal-specificity conflict
   * unrepresentable, so routing is never ambiguous by construction.
   */
  async routesMatching(
    matchedSender: string | null,
  ): Promise<Array<{ ownerId: string; spaceId: string }>> {
    if (!matchedSender) return [];
    const rows = await this.db
      .select({
        ownerId: emailAllowlist.ownerId,
        kind: emailAllowlist.kind,
        value: emailAllowlist.value,
        spaceId: emailAllowlist.spaceId,
      })
      .from(emailAllowlist);
    const byOwner = new Map<string, Array<AllowlistEntry & { spaceId: string }>>();
    for (const row of rows) {
      const list = byOwner.get(row.ownerId) ?? [];
      list.push({ kind: row.kind, value: row.value, spaceId: row.spaceId });
      byOwner.set(row.ownerId, list);
    }
    const routes: Array<{ ownerId: string; spaceId: string }> = [];
    for (const [ownerId, entries] of byOwner) {
      if (!senderMatchesAllowlist(matchedSender, entries)) continue;
      const matched = entries.filter((entry) => senderMatchesAllowlist(matchedSender, [entry]));
      const winner = matched.find((entry) => entry.kind === 'address') ?? matched[0]!;
      routes.push({ ownerId, spaceId: winner.spaceId });
    }
    return routes.sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  }

  /** The owner's entries for the management surface, newest first. */
  async listForOwner(ownerId: string): Promise<EmailAllowlistEntryDto[]> {
    const rows = await this.db
      .select()
      .from(emailAllowlist)
      .where(eq(emailAllowlist.ownerId, ownerId))
      .orderBy(desc(emailAllowlist.createdAt));
    return rows.map(toEntryDto);
  }

  /**
   * Add an address or whole-domain entry, normalized (ruling 2a),
   * idempotently (adding an existing entry returns it). Audited.
   */
  async addEntry(
    principal: Principal,
    request: AddEmailAllowlistEntryRequest,
  ): Promise<EmailAllowlistEntryDto> {
    const value = normalizeAllowlistValue(request.kind, request.value);
    if (!value) {
      throw request.kind === 'address'
        ? userError.badRequest('email.invalidAddress', 'not a valid email address')
        : userError.badRequest(
            'email.invalidDomain',
            'not a valid domain (e.g. adriatic-foods.hr)',
          );
    }
    const note = request.note?.trim() || null;
    // The rule's TARGET space. Absent, it resolves to the CALLER's current
    // space (the x-cogeto-space rule), never to a constant: a caller standing
    // in space B who names no target routes that sender's mail to B, and a
    // headerless caller resolves to the default space, byte-identical to the
    // prior behaviour (spaces verification F6).
    const spaceId = request.spaceId ?? resolveSpaceId(principal);

    return this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(emailAllowlist)
        .values({ ownerId: principal.userId, kind: request.kind, value, note, spaceId })
        .onConflictDoNothing({
          target: [emailAllowlist.ownerId, emailAllowlist.kind, emailAllowlist.value],
        })
        .returning()
        .catch((error: unknown) => {
          // The space foreign key is the loud backstop: a target that does
          // not exist (deleted between the picker and the submit) is a
          // legible refusal, never a silent fallback.
          if (isForeignKeyViolation(error)) {
            throw userError.badRequest('email.unknownSpace', 'that space no longer exists');
          }
          throw error;
        });

      let row =
        inserted ??
        (
          await tx
            .select()
            .from(emailAllowlist)
            .where(
              and(
                eq(emailAllowlist.ownerId, principal.userId),
                eq(emailAllowlist.kind, request.kind),
                eq(emailAllowlist.value, value),
              ),
            )
            .limit(1)
        )[0]!;

      // Re-adding an existing sender with a DIFFERENT target space is a
      // deliberate retarget, never a silent no-op returning the old routing
      // (docs/features/spaces.md section 6c: no silent misconfiguration).
      if (!inserted && row.spaceId !== spaceId) {
        const [updated] = await tx
          .update(emailAllowlist)
          .set({ spaceId })
          .where(eq(emailAllowlist.id, row.id))
          .returning()
          .catch((error: unknown) => {
            if (isForeignKeyViolation(error)) {
              throw userError.badRequest('email.unknownSpace', 'that space no longer exists');
            }
            throw error;
          });
        row = updated!;
        await writeAudit(tx, {
          actor: `user:${principal.userId}`,
          action: 'email_allowlist.retarget',
          entityType: 'email_allowlist',
          entityId: row.id,
          detail: { kind: request.kind },
          orgId: principal.orgId,
          ownerId: principal.userId,
          spaceId,
        });
      }

      if (inserted) {
        // Structural metadata only: kind + a boolean, never the value or
        // note (which can carry PII) — the audit trail is org-readable.
        await writeAudit(tx, {
          actor: `user:${principal.userId}`,
          action: 'email_allowlist.add',
          entityType: 'email_allowlist',
          entityId: row.id,
          detail: { kind: request.kind, hasNote: note !== null },
          orgId: principal.orgId,
          ownerId: principal.userId,
          spaceId,
        });
      }
      return toEntryDto(row);
    });
  }

  /** The owner's alias routing rules, newest first. */
  async listAliasesForOwner(ownerId: string): Promise<EmailAliasDto[]> {
    const rows = await this.db
      .select()
      .from(emailAlias)
      .where(eq(emailAlias.ownerId, ownerId))
      .orderBy(desc(emailAlias.createdAt));
    return rows.map(toAliasDto);
  }

  /**
   * Add an alias routing rule (docs/features/spaces.md section 6c): the tag
   * after the plus in `capture+alias@instance`, mapped to exactly one space.
   * The alias is normalized; a duplicate alias for the same owner is refused
   * (retargeting an alias is remove-and-add, deliberate, never a silent
   * overwrite of where a client's mail lands). Audited.
   */
  async addAlias(principal: Principal, request: AddEmailAliasRequest): Promise<EmailAliasDto> {
    const alias = normalizeAlias(request.alias);
    if (!alias) {
      throw userError.badRequest(
        'email.invalidAlias',
        'not a valid alias (letters, digits, dot, dash, underscore, up to 64 characters)',
      );
    }
    const note = request.note?.trim() || null;
    return this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(emailAlias)
        .values({ ownerId: principal.userId, alias, spaceId: request.spaceId, note })
        .onConflictDoNothing({ target: [emailAlias.ownerId, emailAlias.alias] })
        .returning()
        .catch((error: unknown) => {
          if (isForeignKeyViolation(error)) {
            throw userError.badRequest('email.unknownSpace', 'that space no longer exists');
          }
          throw error;
        });
      if (!inserted) {
        throw userError.conflict(
          'email.aliasExists',
          'an alias with this name already exists; remove it first to change where it routes',
        );
      }
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'email_alias.add',
        entityType: 'email_alias',
        entityId: inserted.id,
        detail: { hasNote: note !== null },
        orgId: principal.orgId,
        ownerId: principal.userId,
        spaceId: request.spaceId,
      });
      return toAliasDto(inserted);
    });
  }

  /** Remove an alias rule the caller owns. Audited. False when not found. */
  async removeAlias(principal: Principal, id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [deleted] = await tx
        .delete(emailAlias)
        .where(and(eq(emailAlias.id, id), eq(emailAlias.ownerId, principal.userId)))
        .returning({ id: emailAlias.id, spaceId: emailAlias.spaceId });
      if (!deleted) return false;
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'email_alias.remove',
        entityType: 'email_alias',
        entityId: deleted.id,
        detail: {},
        orgId: principal.orgId,
        ownerId: principal.userId,
        spaceId: deleted.spaceId,
      });
      return true;
    });
  }

  /**
   * The target space of one owner's alias rule, or null when the owner has
   * not defined the alias — which the intake REFUSES rather than defaulting
   * (docs/features/spaces.md section 6c).
   */
  async aliasRouteFor(ownerId: string, alias: string): Promise<string | null> {
    const rows = await this.db
      .select({ spaceId: emailAlias.spaceId })
      .from(emailAlias)
      .where(and(eq(emailAlias.ownerId, ownerId), eq(emailAlias.alias, alias)))
      .limit(1);
    return rows[0]?.spaceId ?? null;
  }

  /** Remove an entry the caller owns. Audited. Returns false when not found. */
  async removeEntry(principal: Principal, id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [deleted] = await tx
        .delete(emailAllowlist)
        .where(and(eq(emailAllowlist.id, id), eq(emailAllowlist.ownerId, principal.userId)))
        .returning({ id: emailAllowlist.id, kind: emailAllowlist.kind });
      if (!deleted) return false;
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'email_allowlist.remove',
        entityType: 'email_allowlist',
        entityId: deleted.id,
        detail: { kind: deleted.kind },
        orgId: principal.orgId,
        ownerId: principal.userId,
      });
      return true;
    });
  }

  /**
   * Record a refused message — metadata only, never a body (ruling
   * 7). `ownerId` may be null when the refusal happened before owner resolution.
   * Best-effort: pass the surrounding tx when one is open, else the pool.
   */
  async recordRefusal(
    executor: DbOrTx,
    refusal: {
      ownerId: string | null;
      fromAddr: string | null;
      toAddr: string | null;
      reason: string;
    },
  ): Promise<void> {
    await executor.insert(emailRefusal).values({
      ownerId: refusal.ownerId,
      fromAddr: refusal.fromAddr,
      toAddr: refusal.toAddr,
      reason: refusal.reason,
    });
  }

  /**
   * Recent refusals for the owner (plus system refusals with no owner yet). The
   * owner/null predicate is in the WHERE, BEFORE the LIMIT (/GAP-12), so
   * another user's refusals can no longer crowd this user's claimable rows out
   * of the window.
   */
  async recentRefusalsForOwner(ownerId: string): Promise<EmailRefusalDto[]> {
    const rows = await this.db
      .select()
      .from(emailRefusal)
      .where(or(isNull(emailRefusal.ownerId), eq(emailRefusal.ownerId, ownerId)))
      .orderBy(desc(emailRefusal.refusedAt))
      .limit(RECENT_REFUSALS_LIMIT);
    return rows.map((r) => ({
      id: r.id,
      fromAddr: r.fromAddr,
      reason: r.reason,
      refusedAt: r.refusedAt.toISOString(),
    }));
  }

  /**
   * Prune refused-mail records older than `days` (/GAP-6) — bounds the
   * retained third-party sender PII and the table's growth on a public inbound
   * port. Idempotent; returns the number removed.
   */
  async pruneRefusalsOlderThan(days: number = REFUSAL_RETENTION_DAYS): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const removed = await this.db
      .delete(emailRefusal)
      .where(lt(emailRefusal.refusedAt, cutoff))
      .returning({ id: emailRefusal.id });
    return removed.length;
  }
}

function toEntryDto(row: EmailAllowlistRow): EmailAllowlistEntryDto {
  return {
    id: row.id,
    kind: row.kind,
    value: row.value,
    note: row.note,
    spaceId: row.spaceId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAliasDto(row: EmailAliasRow): EmailAliasDto {
  return {
    id: row.id,
    alias: row.alias,
    spaceId: row.spaceId,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Postgres foreign-key violation (SQLSTATE 23503), however drizzle wraps it. */
function isForeignKeyViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown; cause?: { code?: unknown } }).code;
  const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
  return code === '23503' || causeCode === '23503';
}
