import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import type {
  AddEmailAllowlistEntryRequest,
  EmailAllowlistEntryDto,
  EmailRefusalDto,
  Principal,
} from '@cogeto/shared';
import { DRIZZLE, writeAudit } from '../infrastructure/index';
import type { Db, DbOrTx } from '../infrastructure/index';
import { emailAllowlist, emailRefusal } from './persistence/tables';
import type { EmailAllowlistRow } from './persistence/tables';
import { normalizeAllowlistValue, senderMatchesAllowlist } from './email-parse';
import type { AllowlistEntry } from './email-parse';

/** How many recent refusals the Settings surface shows (one-click allowlisting). */
const RECENT_REFUSALS_LIMIT = 20;

/**
 * Refused mail records hold third-party sender addresses (PII) and, on an
 * internet-facing SMTP port, grow unbounded from unknown senders (SEC-6/GAP-6).
 * A nightly pass prunes rows older than this window — long enough to remain
 * useful for one-click allowlisting, short enough to bound the retained PII.
 */
export const REFUSAL_RETENTION_DAYS = 30;
export const EMAIL_REFUSAL_RETENTION_JOB_TYPE = 'email_refusal_retention';
/** Daily at 03:50 UTC — after the other nightly passes (worker pins TZ=UTC). */
export const EMAIL_REFUSAL_RETENTION_CRONTAB = `50 3 * * * ${EMAIL_REFUSAL_RETENTION_JOB_TYPE}`;

/**
 * The per-user sender allowlist — personal routing for external senders
 * (decision 0031 rule 2: "senders whose mail I want in MY memory") — plus the
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
   * copy of the message (decision 0031 rule 2). Empty for an unmatched or
   * unparsable sender (closed by default).
   */
  async ownersMatching(matchedSender: string | null): Promise<string[]> {
    if (!matchedSender) return [];
    const rows = await this.db
      .select({
        ownerId: emailAllowlist.ownerId,
        kind: emailAllowlist.kind,
        value: emailAllowlist.value,
      })
      .from(emailAllowlist);
    const byOwner = new Map<string, AllowlistEntry[]>();
    for (const row of rows) {
      const list = byOwner.get(row.ownerId) ?? [];
      list.push({ kind: row.kind, value: row.value });
      byOwner.set(row.ownerId, list);
    }
    const owners: string[] = [];
    for (const [ownerId, entries] of byOwner) {
      if (senderMatchesAllowlist(matchedSender, entries)) owners.push(ownerId);
    }
    return owners.sort();
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
   * Add an address or whole-domain entry, normalized (decision 0028 ruling 2a),
   * idempotently (adding an existing entry returns it). Audited.
   */
  async addEntry(
    principal: Principal,
    request: AddEmailAllowlistEntryRequest,
  ): Promise<EmailAllowlistEntryDto> {
    const value = normalizeAllowlistValue(request.kind, request.value);
    if (!value) {
      throw new BadRequestException(
        request.kind === 'address'
          ? 'not a valid email address'
          : 'not a valid domain (e.g. adriatic-foods.hr)',
      );
    }
    const note = request.note?.trim() || null;

    return this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(emailAllowlist)
        .values({ ownerId: principal.userId, kind: request.kind, value, note })
        .onConflictDoNothing({
          target: [emailAllowlist.ownerId, emailAllowlist.kind, emailAllowlist.value],
        })
        .returning();

      const row =
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

      if (inserted) {
        // Structural metadata only (QS-1): kind + a boolean, never the value or
        // note (which can carry PII) — the audit trail is org-readable.
        await writeAudit(tx, {
          actor: `user:${principal.userId}`,
          action: 'email_allowlist.add',
          entityType: 'email_allowlist',
          entityId: row.id,
          detail: { kind: request.kind, hasNote: note !== null },
          orgId: principal.orgId,
          ownerId: principal.userId,
        });
      }
      return toEntryDto(row);
    });
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
   * Record a refused message — metadata only, never a body (decision 0028 ruling
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
   * owner/null predicate is in the WHERE, BEFORE the LIMIT (SEC-8/GAP-12), so
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
   * Prune refused-mail records older than `days` (SEC-6/GAP-6) — bounds the
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
    createdAt: row.createdAt.toISOString(),
  };
}
