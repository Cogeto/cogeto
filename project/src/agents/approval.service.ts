import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type {
  ApprovalDto,
  EmailReplyDraftPayload,
  EmailReplyDraftView,
  Principal,
} from '@cogeto/shared';
import { EMAIL_REPLY_DRAFT_ACTION } from '@cogeto/shared';
import { auditLog, DRIZZLE, withTransactionalEnqueue, writeAudit } from '../infrastructure/index';
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
 * The approval state machine's write + query surface (§A.8). The confirm
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
      });
      return created;
    });
    return this.toDto(row);
  }

  /**
   * The authenticated confirm transition (approve|reject) — the ONLY approval
   * path. Owner org only (a foreign-org approval is NotFound, never leaked).
   * Approve → `approved` + enqueue the execution job (worker-only, §A.8);
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
      const check = checkApprovalTransition(current.status, to);
      if (!check.allowed) throw new UnprocessableEntityException(check.reason);

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
    return this.toDto(row);
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
        });
      }
      return stale.length;
    });
  }

  async listPending(principal: Principal): Promise<ApprovalDto[]> {
    const rows = await this.db
      .select()
      .from(approval)
      .where(and(eq(approval.orgId, principal.orgId), eq(approval.status, 'pending_approval')))
      .orderBy(desc(approval.createdAt))
      .limit(200);
    return this.toDtos(rows as ApprovalRow[]);
  }

  async listHistory(principal: Principal): Promise<ApprovalDto[]> {
    const rows = await this.db
      .select()
      .from(approval)
      .where(
        and(eq(approval.orgId, principal.orgId), inArray(approval.status, [...HISTORY_STATUSES])),
      )
      .orderBy(desc(approval.decidedAt))
      .limit(200);
    return this.toDtos(rows as ApprovalRow[]);
  }

  async get(principal: Principal, id: string): Promise<ApprovalDto> {
    const rows = await this.db.select().from(approval).where(eq(approval.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.orgId !== principal.orgId)
      throw new NotFoundException(`approval ${id} not found`);
    return (await this.toDtos([row as ApprovalRow]))[0]!;
  }

  /**
   * The finalised reply draft (Session O4): the drafted subject + body, plus a
   * ready-to-open mailto: and a downloadable .eml. OWNER-only (the body is
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
      row.requestedBy !== principal.userId ||
      row.actionType !== EMAIL_REPLY_DRAFT_ACTION
    ) {
      throw new NotFoundException(`email draft ${id} not found`);
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
    if (!row || row.orgId !== principal.orgId) {
      throw new NotFoundException(`approval ${id} not found`);
    }
    return row as ApprovalRow;
  }

  private toDto(row: ApprovalRow, result: string | null = null): ApprovalDto {
    const def = this.registry.get(row.actionType);
    const payload = def.schema.safeParse(row.payloadJson);
    return {
      id: row.id,
      actionType: row.actionType,
      status: row.status,
      summary: payload.success ? def.summarize(payload.data) : row.actionType,
      preview: payload.success ? def.preview(payload.data) : [],
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
  private async toDtos(rows: ApprovalRow[]): Promise<ApprovalDto[]> {
    const executed = rows.filter((r) => r.status === 'executed').map((r) => r.id);
    const results = new Map<string, string>();
    if (executed.length > 0) {
      const auditRows = await this.db
        .select({ id: auditLog.entityId, summary: sql<string>`${auditLog.detailJson}->>'summary'` })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'approval.executed'), inArray(auditLog.entityId, executed)));
      for (const a of auditRows) if (a.summary) results.set(a.id, a.summary);
    }
    return rows.map((r) => this.toDto(r, results.get(r.id) ?? null));
  }
}

/** A prefilled mailto: link — opens the user's own client, ready to send. */
function buildMailto(p: EmailReplyDraftPayload): string {
  const params = new URLSearchParams({ subject: p.subject, body: p.body });
  return `mailto:${encodeURIComponent(p.to)}?${params.toString()}`;
}

/**
 * A minimal RFC822 .eml the user downloads and sends from any client. It carries
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
