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
import type { DeadLetterJobDto, WorkerActivityDto, WorkerJobDto } from '@cogeto/shared';
import {
  DRIZZLE,
  listDeadLetters,
  listQueuedJobs,
  queueTotals,
  recentJobExecutions,
  retryDeadLetter,
  writeAudit,
} from '../infrastructure/index';
import type { Db, QueuedJobRow } from '../infrastructure/index';
import { AdminGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';

/**
 * /api/jobs — the dashboard's System view over the queue's own ledgers (spec §15.4).
 * The ledgers are infrastructure's; every read and the retry transaction go
 * through its public interface. What stays here is the admin gate, the DTO
 * shapes and the running/queued/waiting classification.
 *
 * ADMIN-ONLY: activity/dead-letter expose cross-user source ids and
 * object keys, and retry replays ANY parked job — operator concerns, not
 * per-user data. The global BearerAuthGuard authenticates; AdminGuard then
 * requires the configured admin role. (Owner-scoping was rejected: most queue
 * jobs — sweep/dream/backfill/expiry — carry no user owner, so a per-owner
 * filter would both hide operational state and still leak by omission.)
 *
 * Retry re-enqueues the parked payload and removes the dead-letter row in one
 * transaction. Double effects are impossible regardless of how often a job is
 * retried: the idempotentTask guard claims the (source_type, source_id,
 * job_type) key before the handler's effect — a re-run of completed work skips.
 */
@Controller('jobs')
@UseGuards(AdminGuard)
export class JobsController {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * A live snapshot of the queue for the System "Worker activity" panel
   * what's running now, what's waiting, and what recently completed — read from
   * graphile-worker's own tables + the job_execution ledger. No per-job
   * percentage exists (a job is one atomic transaction); queue depth is the
   * honest progress signal.
   */
  @Get('activity')
  async activity(): Promise<WorkerActivityDto> {
    const rows = await listQueuedJobs(this.db);

    const iso = (value: Date | null): string | null => value?.toISOString() ?? null;
    const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    const toJob = (r: QueuedJobRow): WorkerJobDto => ({
      jobType: r.jobType,
      sourceType: str(r.payload?.source_type),
      sourceId: str(r.payload?.source_id),
      attempts: r.attempts,
      maxAttempts: r.maxAttempts,
      since: iso(r.lockedAt),
      runAt: iso(r.runAt),
      lastError: r.lastError,
    });

    const now = Date.now();
    const running: WorkerJobDto[] = [];
    const queued: WorkerJobDto[] = [];
    const waiting: WorkerJobDto[] = [];
    for (const r of rows) {
      if (r.lockedAt) running.push(toJob(r));
      else if (r.runAt != null && r.runAt.getTime() <= now) queued.push(toJob(r));
      else waiting.push(toJob(r));
    }

    const recentRows = await recentJobExecutions(this.db);
    const recent = recentRows.map((row) => ({
      jobType: row.jobType,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      at: row.executedAt.toISOString(),
    }));

    const totals = await queueTotals(this.db);

    return {
      running,
      queued,
      waiting,
      recent,
      summary: {
        running: running.length,
        queued: queued.length,
        waiting: waiting.length,
        deadLetter: totals.deadLettered,
        completedTotal: totals.completed,
      },
    };
  }

  @Get('dead-letter')
  async deadLetterList(): Promise<DeadLetterJobDto[]> {
    const rows = await listDeadLetters(this.db);
    return rows.map((row) => {
      const payload = row.payload ?? {};
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
      const row = await retryDeadLetter(tx, id);
      if (!row) throw new NotFoundException(`dead-letter job ${id} not found`);
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
