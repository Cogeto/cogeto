import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Principal, SkillRunStatus, SkillStepLinks, SkillStepStatus } from '@cogeto/shared';
import { DRIZZLE, userError, writeAudit } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { skillRun, skillRunStep } from './persistence/tables';
import type { SkillRunRow, SkillRunStepRow } from './persistence/tables';
import type { SkillDefinition } from './skill-registry';

/** The worker's re-runnable advance job. */
export const SKILL_ADVANCE_JOB_TYPE = 'skill.advance';

const TERMINAL_STATUSES: readonly SkillRunStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * The skill run record and its step log —
 * rows only, no orchestration: transitions are compare-and-set so the
 * re-runnable advance job and a concurrent cancel always have exactly one
 * winner, and every run transition audits structurally (never content).
 */
@Injectable()
export class SkillRunService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Create the run in `planning` with its full step log from the plan. */
  async createRun(
    principal: Principal,
    skill: SkillDefinition,
    subject: string,
  ): Promise<SkillRunRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(skillRun)
        .values({
          ownerId: principal.userId,
          orgId: principal.orgId,
          skillId: skill.id,
          skillVersion: skill.version,
          subject,
        })
        .returning();
      await tx.insert(skillRunStep).values(
        skill.steps.map((step, position) => ({
          skillRunId: row!.id,
          position,
          stepKey: step.key,
          kind: step.kind,
        })),
      );
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'skill_run.proposed',
        entityType: 'skill_run',
        entityId: row!.id,
        detail: { skill_id: skill.id, skill_version: skill.version },
        orgId: principal.orgId,
        ownerId: principal.userId,
      });
      return row!;
    });
  }

  async getRun(principal: Principal, runId: string): Promise<SkillRunRow | null> {
    const rows = await this.db
      .select()
      .from(skillRun)
      .where(and(eq(skillRun.id, runId), eq(skillRun.ownerId, principal.userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** System read for the worker's advance job — the row's ownerId scopes
   * everything after (the research conclusion precedent). */
  async getRunById(runId: string): Promise<SkillRunRow | null> {
    const rows = await this.db.select().from(skillRun).where(eq(skillRun.id, runId)).limit(1);
    return rows[0] ?? null;
  }

  async listRuns(principal: Principal, limit = 50): Promise<SkillRunRow[]> {
    return this.db
      .select()
      .from(skillRun)
      .where(eq(skillRun.ownerId, principal.userId))
      .orderBy(desc(skillRun.createdAt))
      .limit(limit);
  }

  async steps(runId: string): Promise<SkillRunStepRow[]> {
    return this.db
      .select()
      .from(skillRunStep)
      .where(eq(skillRunStep.skillRunId, runId))
      .orderBy(skillRunStep.position);
  }

  /**
   * Claim a step for execution — re-entrant on purpose: a re-delivered advance
   * job may claim a step already `running` (crash before completion) or
   * `failed` (retry after backoff) and continue idempotently.
   */
  async claimStep(runId: string, stepKey: string): Promise<SkillRunStepRow | null> {
    const rows = await this.db
      .update(skillRunStep)
      .set({ status: 'running', startedAt: sql`coalesce(${skillRunStep.startedAt}, now())` })
      .where(
        and(
          eq(skillRunStep.skillRunId, runId),
          eq(skillRunStep.stepKey, stepKey),
          inArray(skillRunStep.status, ['pending', 'running', 'failed']),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Checkpoint a step's outcome; links merge shallowly over what is recorded. */
  async finishStep(
    runId: string,
    stepKey: string,
    outcome: {
      status: Extract<SkillStepStatus, 'completed' | 'skipped'>;
      outputsSummary?: string;
      links?: SkillStepLinks;
    },
  ): Promise<void> {
    await this.patchStep(runId, stepKey, {
      status: outcome.status,
      outputsSummary: outcome.outputsSummary,
      links: outcome.links,
      finished: true,
    });
  }

  /** Record a step failure honestly (the run view shows it); the advance job
   * rethrows so the queue retries with backoff and dead-letters visibly. */
  async failStep(runId: string, stepKey: string, error: string): Promise<void> {
    await this.db
      .update(skillRunStep)
      .set({ status: 'failed', error: error.slice(0, 500) })
      .where(and(eq(skillRunStep.skillRunId, runId), eq(skillRunStep.stepKey, stepKey)));
  }

  async patchStep(
    runId: string,
    stepKey: string,
    patch: {
      status?: SkillStepStatus;
      inputsSummary?: string;
      outputsSummary?: string;
      links?: SkillStepLinks;
      finished?: boolean;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(skillRunStep)
        .where(and(eq(skillRunStep.skillRunId, runId), eq(skillRunStep.stepKey, stepKey)))
        .for('update');
      const row = rows[0];
      if (!row) return;
      const links = patch.links
        ? { ...(row.links as SkillStepLinks), ...patch.links }
        : (row.links as SkillStepLinks);
      await tx
        .update(skillRunStep)
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.inputsSummary !== undefined ? { inputsSummary: patch.inputsSummary } : {}),
          ...(patch.outputsSummary !== undefined ? { outputsSummary: patch.outputsSummary } : {}),
          links,
          ...(patch.finished ? { finishedAt: new Date(), error: null } : {}),
        })
        .where(eq(skillRunStep.id, row.id));
    });
  }

  /** Compare-and-set run status; returns whether this caller won the write. */
  async transition(
    runId: string,
    from: SkillRunStatus | SkillRunStatus[],
    to: SkillRunStatus,
    patch: Partial<{
      brief: string;
      briefCitations: unknown;
      failureReason: string;
    }> = {},
  ): Promise<SkillRunRow | null> {
    const fromList = Array.isArray(from) ? from : [from];
    const terminal = TERMINAL_STATUSES.includes(to);
    const rows = await this.db
      .update(skillRun)
      .set({
        status: to,
        ...(patch.brief !== undefined ? { brief: patch.brief } : {}),
        ...(patch.briefCitations !== undefined ? { briefCitations: patch.briefCitations } : {}),
        ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
        ...(terminal ? { finishedAt: new Date() } : {}),
      })
      .where(and(eq(skillRun.id, runId), inArray(skillRun.status, fromList)))
      .returning();
    return rows[0] ?? null;
  }

  /** Audit a run transition (structural detail only — never content). */
  async auditRun(
    actor: string,
    action: string,
    run: Pick<SkillRunRow, 'id' | 'ownerId'>,
    detail: Record<string, unknown> = {},
    orgId?: string,
  ): Promise<void> {
    await writeAudit(this.db, {
      actor,
      action,
      entityType: 'skill_run',
      entityId: run.id,
      detail,
      ...(orgId ? { orgId } : {}),
      ownerId: run.ownerId,
    });
  }

  /**
   * Cancel cleanly: the run stops at the next step
   * boundary and keeps everything already produced. Idempotent; terminal runs
   * refuse.
   */
  async cancel(principal: Principal, runId: string): Promise<SkillRunRow> {
    const run = await this.getRun(principal, runId);
    if (!run) throw userError.notFound('skill.runNotFound', 'no such skill run');
    if (run.status === 'cancelled') return run;
    if (TERMINAL_STATUSES.includes(run.status)) {
      throw userError.conflict('skill.alreadyFinished', 'this skill run already finished');
    }
    const updated = await this.transition(
      runId,
      ['planning', 'awaiting_approval', 'running', 'awaiting_input'],
      'cancelled',
    );
    if (!updated) return (await this.getRun(principal, runId))!;
    await this.auditRun(
      `user:${principal.userId}`,
      'skill_run.cancelled',
      updated,
      {},
      principal.orgId,
    );
    return updated;
  }
}
