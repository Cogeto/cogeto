import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
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
 * The sender allowlist — the primary acceptance gate (decision 0028 rulings
 * 2/7) — plus the metadata-only refusal log. Owned by connectors. The intake
 * consults `matches` before storing anything; the Settings surface manages
 * entries (audited) and reads recent refusals. Empty allowlist → closed by
 * default: `matches` returns false for every sender.
 */
@Injectable()
export class EmailAllowlistService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** The acceptance decision for one owner's inbound mail (closed by default). */
  async matches(ownerId: string, matchedSender: string | null): Promise<boolean> {
    const entries = await this.loadEntries(ownerId);
    return senderMatchesAllowlist(matchedSender, entries);
  }

  private async loadEntries(ownerId: string): Promise<AllowlistEntry[]> {
    const rows = await this.db
      .select({ kind: emailAllowlist.kind, value: emailAllowlist.value })
      .from(emailAllowlist)
      .where(eq(emailAllowlist.ownerId, ownerId));
    return rows.map((r) => ({ kind: r.kind, value: r.value }));
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

  /** Recent refusals for the owner (plus system refusals with no owner yet). */
  async recentRefusalsForOwner(ownerId: string): Promise<EmailRefusalDto[]> {
    const rows = await this.db
      .select()
      .from(emailRefusal)
      .orderBy(desc(emailRefusal.refusedAt))
      .limit(RECENT_REFUSALS_LIMIT);
    return rows
      .filter((r) => r.ownerId === null || r.ownerId === ownerId)
      .map((r) => ({
        id: r.id,
        fromAddr: r.fromAddr,
        reason: r.reason,
        refusedAt: r.refusedAt.toISOString(),
      }));
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
