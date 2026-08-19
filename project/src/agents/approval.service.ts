import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type {
  ApprovalDto,
  EmailReplyDraftPayload,
  EmailReplyDraftView,
  Principal,
} from '@cogeto/shared';
import { EMAIL_REPLY_DRAFT_ACTION, resolveSpaceId } from '@cogeto/shared';
import {
  DRIZZLE,
  readAuditEntries,
  untranslatedError,
  userError,
  withTransactionalEnqueue,
  writeAudit,
} from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import { approval } from './persistence/tables';
import type { ApprovalRow } from './persistence/tables';
import { ActionRegistry } from './action-registry';
import {
  APPROVAL_EXECUTE_JOB_TYPE,
  APPROVAL_JOB_SOURCE_TYPE,
  checkApprovalTransition,
} from './domain/approval-machine';

const HISTORY_STATUSES = ['executed', 'rejected', 'expired'] as const;

/**
 * The approval state machine's write + query surface. The confirm
 * endpoint calls `confirm` — which ONLY flips state and (on approve) enqueues
 * the worker execution job through the outbox; it never runs an effect. The
 * scheduled pass calls `expireStale`. All transitions are audit-logged.
 */
@Injectable()
export class ApprovalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: ActionRegistry,
  ) {}

  /** Create an approval for a registered action, authorized against the caller. */
  async create(
    principal: Principal,
    actionType: string,
    rawPayload: unknown,
  ): Promise<ApprovalDto> {
    const def = this.registry.get(actionType);
    const payload = this.registry.parse(actionType, rawPayload);
    await def.authorizeCreate?.(principal, payload);

    const expiresAt = new Date(Date.now() + def.ttlSeconds * 1000);
    const row = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(approval)
        .values({
          actionType,
          payloadJson: payload as Record<string, unknown>,
          status: def.initialStatus,
          orgId: principal.orgId,
          // The space whose content the action is over, stamped at creation
          // from the requester's current space (docs/features/spaces.md):
          // the approvals queue is a space-scoped sidebar surface.
          spaceId: resolveSpaceId(principal),
          requestedBy: principal.userId,
          expiresAt,
        })
        .returning();
      const created = inserted as ApprovalRow;
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'approval.created',
        entityType: 'approval',
        entityId: created.id,
        detail: { actionType, status: created.status },
        orgId: principal.orgId,
        ownerId: principal.userId,
        spaceId: created.spaceId,
      });
      return created;
    });
    return this.toDto(row, principal.userId);
  }

  /**
   * The authenticated confirm transition (approve|reject) — the ONLY approval
   * path. Owner org only (a foreign-org approval is NotFound, never leaked).
   * Approve → `approved` + enqueue the execution job (worker-only);
   * reject → `rejected`. Nothing else happens here.
   */
  async confirm(
    principal: Principal,
    id: string,
    decision: 'approve' | 'reject',
  ): Promise<ApprovalDto> {
    const to = decision === 'approve' ? 'approved' : 'rejected';
    const row = await this.db.transaction(async (tx) => {
      const current = await this.lockForOrg(tx, principal, id);
      // Audit 2.0 SEC-33: same-org is NOT enough to decide an approval whose
      // effect targets another user's data. The executor reconstructs the
      // action context from the approval row, so the effect always runs AS THE
      // REQUESTER (`ctx.userId`) and lands on the requester's rows — a
      // teammate approving it is one person deciding what happens to another
      // person's memories. Owner identity is required unless the action type
      // declares itself genuinely org-scoped (shared state, anyone may decide).
      //
      // A content-bearing approval (e.g. a reply draft) was already owner-only
      // and stays so; the difference is that owner-only is now the DEFAULT and
      // org-wide is the opt-in. Refused as NotFound, not Forbidden, so the
      // existence of a teammate's approval is not leaked either way.
      const definition = this.registry.get(current.actionType);
      const ownerOnly = definition.contentBearing === true || definition.orgScoped !== true;
      if (ownerOnly && current.requestedBy !== principal.userId) {
        throw userError.notFound('approval.notFound', 'approval {{id}} not found', { id });
      }
      const check = checkApprovalTransition(current.status, to);
      if (!check.allowed) throw untranslatedError.unprocessable(check.reason);

      const now = new Date();
      const [updated] = await tx
        .update(approval)
        .set({ status: to, decidedBy: principal.userId, decidedAt: now })
        .where(eq(approval.id, id))
        .returning();
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: decision === 'approve' ? 'approval.approved' : 'approval.rejected',
        entityType: 'approval',
        entityId: id,
        detail: { actionType: current.actionType, from: current.status, to },
        ownerId: principal.userId,
        orgId: principal.orgId,
        spaceId: current.spaceId,
      });
      // Execution is a worker job — the confirm endpoint does nothing else.
      if (decision === 'approve') {
        await withTransactionalEnqueue(
          tx,
          {
            type: 'approval.approved',
            payload: { source_type: APPROVAL_JOB_SOURCE_TYPE, source_id: id },
          },
          {
            type: APPROVAL_EXECUTE_JOB_TYPE,
            payload: { source_type: APPROVAL_JOB_SOURCE_TYPE, source_id: id },
          },
        );
      }
      return updated as ApprovalRow;
    });
    return this.toDto(row, principal.userId);
  }

  /**
   * The scheduled expiry pass (worker cron): pending approvals past their
   * expires_at become `expired`, each with its own audit row. Idempotent — a
   * second pass finds none still pending-and-past.
   */
  async expireStale(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const stale = await tx
        .select({
          id: approval.id,
          actionType: approval.actionType,
          orgId: approval.orgId,
          spaceId: approval.spaceId,
          requestedBy: approval.requestedBy,
        })
        .from(approval)
        .where(and(eq(approval.status, 'pending_approval'), lt(approval.expiresAt, sql`now()`)))
        .for('update');
      if (stale.length === 0) return 0;
      const ids = stale.map((r) => r.id);
      await tx.update(approval).set({ status: 'expired' }).where(inArray(approval.id, ids));
      for (const r of stale) {
        await writeAudit(tx, {
          actor: 'scheduler',
          action: 'approval.expired',
          entityType: 'approval',
          entityId: r.id,
          detail: { actionType: r.actionType, from: 'pending_approval', to: 'expired' },
          orgId: r.orgId ?? undefined,
          ownerId: r.requestedBy ?? undefined,
          spaceId: r.spaceId,
        });
      }
      return stale.length;
    });
  }

  /** The caller's current space only (docs/features/spaces.md): an approval
   * raised over space A's content must never surface its summary, or be
   * counted, in space B's queue, feed or dashboard. */
  async listPending(principal: Principal): Promise<ApprovalDto[]> {
    const rows = await this.db
      .select()
      .from(approval)
      .where(
        and(
          eq(approval.orgId, principal.orgId),
          eq(approval.spaceId, resolveSpaceId(principal)),
          eq(approval.status, 'pending_approval'),
        ),
      )
      .orderBy(desc(approval.createdAt))
      .limit(200);
    return this.toDtos(rows as ApprovalRow[], principal.userId);
  }

  async listHistory(principal: Principal): Promise<ApprovalDto[]> {
    const rows = await this.db
      .select()
      .from(approval)
      .where(
        and(
          eq(approval.orgId, principal.orgId),
          eq(approval.spaceId, resolveSpaceId(principal)),
          inArray(approval.status, [...HISTORY_STATUSES]),
        ),
      )
      .orderBy(desc(approval.decidedAt))
      .limit(200);
    return this.toDtos(rows as ApprovalRow[], principal.userId);
  }

  async get(principal: Principal, id: string): Promise<ApprovalDto> {
    const rows = await this.db.select().from(approval).where(eq(approval.id, id)).limit(1);
    const row = rows[0];
    // An approval reached by id from another space reads as not found, the
    // same sealing every by-id read follows (docs/features/spaces.md).
    if (!row || row.orgId !== principal.orgId || row.spaceId !== resolveSpaceId(principal))
      throw userError.notFound('approval.notFound', 'approval {{id}} not found', { id });
    return (await this.toDtos([row as ApprovalRow], principal.userId))[0]!;
  }

  /**
   * The finalised reply draft: the drafted subject + body, plus a
   * ready-to-open mailto: and a downloadable.eml. OWNER-only (the body is
   * content) — a foreign requester, even in the same org, is NotFound. Returned
   * for any status; the UI presents the copy/send affordances once approved.
   * Cogeto never sends: `sent` is always false.
   */
  async getEmailDraft(principal: Principal, id: string): Promise<EmailReplyDraftView> {
    const rows = await this.db.select().from(approval).where(eq(approval.id, id)).limit(1);
    const row = rows[0] as ApprovalRow | undefined;
    if (
      !row ||
      row.orgId !== principal.orgId ||
      row.spaceId !== resolveSpaceId(principal) ||
      row.requestedBy !== principal.userId ||
      row.actionType !== EMAIL_REPLY_DRAFT_ACTION
    ) {
      throw userError.notFound('approval.emailDraftNotFound', 'email draft {{id}} not found', {
        id,
      });
    }
    const payload = this.registry.parse(
      EMAIL_REPLY_DRAFT_ACTION,
      row.payloadJson,
    ) as EmailReplyDraftPayload;
    return {
      approvalId: row.id,
      status: row.status,
      to: payload.to,
      // Legacy drafts (created before the field existed) are treated as resolved.
      recipientResolved: payload.recipientResolved !== false,
      // A body-recovered recipient is a suggestion to verify; legacy
      // drafts (field absent) are treated as verified.
      recipientVerified: payload.recipientVerified !== false,
      subject: payload.subject,
      body: payload.body,
      mailto: buildMailto(payload),
      eml: buildEml(payload),
      sent: false,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async lockForOrg(tx: Tx, principal: Principal, id: string): Promise<ApprovalRow> {
    const rows = await tx.select().from(approval).where(eq(approval.id, id)).for('update');
    const row = rows[0];
    // Existence must not leak across orgs — a foreign approval is "not found".
    // The same holds across spaces: deciding happens from the queue of the
    // space the approval was raised in (docs/features/spaces.md).
    if (!row || row.orgId !== principal.orgId || row.spaceId !== resolveSpaceId(principal)) {
      throw userError.notFound('approval.notFound', 'approval {{id}} not found', { id });
    }
    return row as ApprovalRow;
  }

  private toDto(row: ApprovalRow, viewerId: string, result: string | null = null): ApprovalDto {
    const def = this.registry.get(row.actionType);
    const payload = def.schema.safeParse(row.payloadJson);
    // A content-bearing approval's summary + preview render the requester's
    // content; a non-requester in the same org sees a content-free placeholder
    //. The full artifact is owner-gated at its own endpoint.
    const contentGated = def.contentBearing === true && row.requestedBy !== viewerId;
    return {
      id: row.id,
      actionType: row.actionType,
      status: row.status,
      summary: contentGated
        ? 'Private draft (visible only to the member who requested it)'
        : payload.success
          ? def.summarize(payload.data)
          : row.actionType,
      preview: contentGated
        ? ['The content of this item is visible only to the member who requested it.']
        : payload.success
          ? def.preview(payload.data)
          : [],
      requestedBy: row.requestedBy,
      createdAt: row.createdAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      executedAt: row.executedAt?.toISOString() ?? null,
      result,
    };
  }

  /** Batches the execution-result lookup (from the audit trail) for the list. */
  private async toDtos(rows: ApprovalRow[], viewerId: string): Promise<ApprovalDto[]> {
    const executed = rows.filter((r) => r.status === 'executed').map((r) => r.id);
    const results = new Map<string, string>();
    if (executed.length > 0) {
      const auditRows = await readAuditEntries(this.db, {
        actions: ['approval.executed'],
        entityIds: executed,
      });
      for (const a of auditRows) {
        const summary = a.detail?.['summary'];
        if (typeof summary === 'string' && summary) results.set(a.entityId, summary);
      }
    }
    return rows.map((r) => this.toDto(r, viewerId, results.get(r.id) ?? null));
  }
}

/** A prefilled mailto: link — opens the user's own client, ready to send. */
function buildMailto(p: EmailReplyDraftPayload): string {
  const params = new URLSearchParams({ subject: p.subject, body: p.body });
  return `mailto:${encodeURIComponent(p.to)}?${params.toString()}`;
}

/**
 * A minimal RFC822.eml the user downloads and sends from any client. It carries
 * the threading headers so the reply lands in the right conversation. No From
 * (the user's own client fills it) and, deliberately, no send — this is a file.
 */
function buildEml(p: EmailReplyDraftPayload): string {
  const headers = [
    `To: ${p.to}`,
    `Subject: ${p.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (p.inReplyTo) headers.push(`In-Reply-To: ${p.inReplyTo}`);
  if (p.references.length > 0) headers.push(`References: ${p.references.join(' ')}`);
  return `${headers.join('\r\n')}\r\n\r\n${p.body.replace(/\r?\n/g, '\r\n')}\r\n`;
}
