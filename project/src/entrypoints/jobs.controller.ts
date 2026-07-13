import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import type { DeadLetterJobDto, WorkerActivityDto, WorkerJobDto } from '@cogeto/shared';
import { deadLetter, DRIZZLE, jobExecution, writeAudit } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { AdminGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';

/**
 * /api/jobs — the dashboard's System view over the queue's own ledgers (§A.3).
 * Lives in the entrypoint: queue plumbing is infrastructure, not domain.
 *
 * ADMIN-ONLY (QS-10): activity/dead-letter expose cross-user source ids and
 * object keys, and retry replays ANY parked job — operator concerns, not
 * per-user data. The global BearerAuthGuard authenticates; AdminGuard then
 * requires the configured admin role. (Owner-scoping was rejected: most queue
 * jobs — sweep/dream/backfill/expiry — carry no user owner, so a per-owner
 * filter would both hide operational state and still leak by omission.)
 *
 * Retry re-enqueues the parked payload and removes the dead-letter row in one
 * transaction. Double effects are impossible regardless of how often a job is
 * retried: the idempotentTask guard (S1-B) claims the (source_type, source_id,
 * job_type) key before the handler's effect — a re-run of completed work skips.
 */
@Controller('jobs')
@UseGuards(AdminGuard)
export class JobsController {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * A live snapshot of the queue for the System "Worker activity" panel:
   * what's running now, what's waiting, and what recently completed — read from
   * graphile-worker's own tables + the job_execution ledger. No per-job
   * percentage exists (a job is one atomic transaction); queue depth is the
   * honest progress signal.
   */
  @Get('activity')
  async activity(): Promise<WorkerActivityDto> {
    // The public `jobs` view omits payload (it lives in `_private_jobs`); join
    // on id to recover the source_type/source_id for the display labels.
    const result = await this.db.execute(sql`
      SELECT j.task_identifier, pj.payload, j.run_at, j.attempts, j.max_attempts,
             j.locked_at, j.last_error
      FROM graphile_worker.jobs j
      JOIN graphile_worker._private_jobs pj ON pj.id = j.id
      ORDER BY j.run_at ASC
      LIMIT 200
    `);
    const rows = result.rows as Array<{
      task_identifier: string;
      payload: Record<string, unknown> | null;
      run_at: string | Date | null;
      attempts: number;
      max_attempts: number;
      locked_at: string | Date | null;
      last_error: string | null;
    }>;

    const iso = (value: string | Date | null): string | null =>
      value == null ? null : new Date(value).toISOString();
    const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    const toJob = (r: (typeof rows)[number]): WorkerJobDto => ({
      jobType: r.task_identifier,
      sourceType: str(r.payload?.source_type),
      sourceId: str(r.payload?.source_id),
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      since: iso(r.locked_at),
      runAt: iso(r.run_at),
      lastError: r.last_error,
    });

    const now = Date.now();
    const running: WorkerJobDto[] = [];
    const queued: WorkerJobDto[] = [];
    const waiting: WorkerJobDto[] = [];
    for (const r of rows) {
      if (r.locked_at) running.push(toJob(r));
      else if (r.run_at != null && new Date(r.run_at).getTime() <= now) queued.push(toJob(r));
      else waiting.push(toJob(r));
    }

    const recentRows = await this.db
      .select()
      .from(jobExecution)
      .orderBy(desc(jobExecution.executedAt))
      .limit(8);
    const recent = recentRows.map((row) => ({
      jobType: row.jobType,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      at: row.executedAt.toISOString(),
    }));

    const [{ n: deadLetterCount }] = (
      await this.db.execute(sql`SELECT count(*)::int AS n FROM dead_letter`)
    ).rows as [{ n: number }];
    const [{ n: completedTotal }] = (
      await this.db.execute(sql`SELECT count(*)::int AS n FROM job_execution`)
    ).rows as [{ n: number }];

    return {
      running,
      queued,
      waiting,
      recent,
      summary: {
        running: running.length,
        queued: queued.length,
        waiting: waiting.length,
        deadLetter: deadLetterCount,
        completedTotal,
      },
    };
  }

  @Get('dead-letter')
  async deadLetterList(): Promise<DeadLetterJobDto[]> {
    const rows = await this.db
      .select()
      .from(deadLetter)
      .orderBy(desc(deadLetter.failedAt))
      .limit(100);
    return rows.map((row) => {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        jobType: row.jobType,
        sourceType: typeof payload.source_type === 'string' ? payload.source_type : null,
        sourceId: typeof payload.source_id === 'string' ? payload.source_id : null,
        error: row.error,
        attempts: row.attempts,
        failedAt: row.failedAt.toISOString(),
      };
    });
  }

  @Post('dead-letter/:id/retry')
  async retry(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ retried: boolean }> {
    await this.db.transaction(async (tx) => {
      const rows = await tx.select().from(deadLetter).where(eq(deadLetter.id, id)).for('update');
      const row = rows[0];
      if (!row) throw new NotFoundException(`dead-letter job ${id} not found`);
      await tx.execute(sql`
        SELECT graphile_worker.add_job(
          ${row.jobType},
          payload := ${JSON.stringify(row.payload ?? {})}::json,
          max_attempts := 10
        )
      `);
      await tx.delete(deadLetter).where(eq(deadLetter.id, id));
      await writeAudit(tx, {
        actor: `user:${request.principal.userId}`,
        action: 'job.retried',
        entityType: 'dead_letter',
        entityId: id,
        detail: { jobType: row.jobType, attempts: row.attempts },
        ownerId: request.principal.userId,
        orgId: request.principal.orgId,
      });
    });
    return { retried: true };
  }
}
