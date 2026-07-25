import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { deadLetter, jobExecution, withTransactionalEnqueue } from '../infrastructure/index';
import type { Tx } from '../infrastructure/index';
import { INGESTION_PIPELINE_JOB_TYPE } from '../ingestion/index';
import { researchRun, webPage } from './persistence/tables';
import { SKILL_ADVANCE_JOB_TYPE } from './skills/skill-run.service';

/** The server-side conclusion job (decision 0057): synthesise + store the
 * run's answer once the last captured page's extraction settles. */
export const RESEARCH_CONCLUDE_JOB_TYPE = 'research.conclude';

/**
 * Watches a research run's pages settle (decision 0057). Called by the worker
 * inside the SAME idempotency transaction that just processed a web page's
 * pipeline job — the page's own job_execution claim row is already visible
 * there, so "every page settled" includes the page that triggered the check.
 * When the last page settles (done OR dead-lettered — a permanently failed
 * page must not hold the run's answer hostage), the conclusion job is enqueued
 * transactionally. A duplicate enqueue from two pages settling concurrently is
 * harmless: conclusion is idempotent by construction (terminal status).
 */
@Injectable()
export class ResearchConclusionService {
  private readonly log = new Logger(ResearchConclusionService.name);

  async afterPageProcessed(tx: Tx, pageId: string): Promise<boolean> {
    const pageRows = await tx
      .select({ researchRunId: webPage.researchRunId })
      .from(webPage)
      .where(eq(webPage.id, pageId))
      .limit(1);
    const runId = pageRows[0]?.researchRunId;
    if (!runId) return false;

    const runRows = await tx
      .select({
        status: researchRun.status,
        ownerId: researchRun.ownerId,
        skillRunId: researchRun.skillRunId,
      })
      .from(researchRun)
      .where(eq(researchRun.id, runId))
      .limit(1);
    const run = runRows[0];
    if (!run || run.status !== 'approved') return false;

    // A skill run's query (decision 0059): the skill advances when ALL pages
    // of ALL its research runs settle — its runs stay 'approved' (no per-run
    // answers) and the brief is the conclusion.
    if (run.skillRunId) return this.afterSkillPageProcessed(tx, run.skillRunId);

    const pages = await tx
      .select({ id: webPage.id })
      .from(webPage)
      .where(eq(webPage.researchRunId, runId));
    for (const page of pages) {
      if (!(await this.pageSettled(tx, page.id))) return false;
    }

    await withTransactionalEnqueue(
      tx,
      {
        type: 'research_run.extracted',
        payload: { source_type: 'research_run', source_id: runId, owner_id: run.ownerId },
      },
      {
        type: RESEARCH_CONCLUDE_JOB_TYPE,
        payload: { source_type: 'research_run', source_id: runId },
      },
    );
    this.log.log(`research run ${runId}: all pages settled — conclusion enqueued`);
    return true;
  }

  /** The skill branch of the settle-watcher (decision 0059 ruling 5). A
   * duplicate enqueue from two pages settling concurrently is harmless: the
   * advance job is re-runnable and its steps compare-and-set. */
  private async afterSkillPageProcessed(tx: Tx, skillRunId: string): Promise<boolean> {
    const planRuns = await tx
      .select({ id: researchRun.id, ownerId: researchRun.ownerId })
      .from(researchRun)
      .where(
        and(eq(researchRun.skillRunId, skillRunId), inArray(researchRun.status, ['approved'])),
      );
    if (planRuns.length === 0) return false;
    const pages = await tx
      .select({ id: webPage.id })
      .from(webPage)
      .where(
        inArray(
          webPage.researchRunId,
          planRuns.map((r) => r.id),
        ),
      );
    for (const page of pages) {
      if (!(await this.pageSettled(tx, page.id))) return false;
    }
    await withTransactionalEnqueue(
      tx,
      {
        type: 'skill_run.extracted',
        payload: {
          source_type: 'skill_run',
          source_id: skillRunId,
          owner_id: planRuns[0]!.ownerId,
        },
      },
      {
        type: SKILL_ADVANCE_JOB_TYPE,
        payload: { source_type: 'skill_run', source_id: skillRunId },
      },
    );
    this.log.log(`skill run ${skillRunId}: all pages settled — advance enqueued`);
    return true;
  }

  /** Settled = pipeline ran (job_execution) or parked permanently (dead_letter). */
  private async pageSettled(tx: Tx, pageId: string): Promise<boolean> {
    const done = await tx
      .select({ id: jobExecution.id })
      .from(jobExecution)
      .where(
        and(
          eq(jobExecution.sourceType, 'web'),
          eq(jobExecution.sourceId, pageId),
          eq(jobExecution.jobType, INGESTION_PIPELINE_JOB_TYPE),
        ),
      )
      .limit(1);
    if (done.length > 0) return true;
    const failed = await tx
      .select({ id: deadLetter.id })
      .from(deadLetter)
      .where(
        and(
          eq(deadLetter.jobType, INGESTION_PIPELINE_JOB_TYPE),
          sql`${deadLetter.payload}->>'source_id' = ${pageId}`,
        ),
      )
      .limit(1);
    return failed.length > 0;
  }
}
