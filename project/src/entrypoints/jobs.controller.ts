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
import type { DeadLetterJobDto } from '@cogeto/shared';
import { deadLetter, DRIZZLE, writeAudit } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';

/**
 * /api/jobs — the dashboard's System view over the queue's own ledgers (§A.3).
 * Lives in the entrypoint: queue plumbing is infrastructure, not domain.
 *
 * Retry re-enqueues the parked payload and removes the dead-letter row in one
 * transaction. Double effects are impossible regardless of how often a job is
 * retried: the idempotentTask guard (S1-B) claims the (source_type, source_id,
 * job_type) key before the handler's effect — a re-run of completed work skips.
 */
@Controller('jobs')
@UseGuards(BearerAuthGuard)
export class JobsController {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
      });
    });
    return { retried: true };
  }
}
