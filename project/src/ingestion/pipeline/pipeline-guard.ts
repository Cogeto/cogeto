import { Injectable } from '@nestjs/common';
import {
  acquireJobRunLock,
  consumeIdempotencyKey,
  tryJobRunLock,
} from '../../infrastructure/index';
import type { Tx } from '../../infrastructure/index';
import type { IngestionCancellation, IngestionGuard } from '../../memory/index';
import type { SourceType } from '../../memory/index';
import { INGESTION_PIPELINE_JOB_TYPE } from './pipeline.service';

/**
 * The memory module's IngestionGuard port, implemented where the pipeline job
 * type is owned (QS-5, decision 0024). Runs inside the deletion saga's
 * enumeration transaction:
 *
 * 1. Probe the pipeline's run lock. `idempotentTask` (and `pipeline.run`
 *    itself) acquire that advisory lock BEFORE the idempotency-row insert, so
 *    a successful probe proves no run of this source is in flight — which
 *    makes the key-consuming insert below non-blocking by construction.
 * 2. No run in flight → consume the (source_type, source_id,
 *    ingestion.pipeline) idempotency key: any queued or future delivery finds
 *    it and skips before touching the source. `already_ran` (key present)
 *    means ingestion completed earlier and the saga's enumeration is complete.
 * 3. Run in flight → report it; the saga's held source-row lock serializes
 *    the run's admission checkpoint (row-backed sources), and the run consumes
 *    its own key when it commits (as a no-op if the checkpoint aborted it).
 *    With `waitForRun` (discard-mode files: no row to serialize on) this call
 *    instead BLOCKS on the run lock until the in-flight run finishes, then
 *    consumes the key — the saga's enumeration afterwards sees everything the
 *    run committed.
 */
@Injectable()
export class PipelineIngestionGuard implements IngestionGuard {
  async cancelPending(
    tx: Tx,
    sourceType: SourceType,
    sourceId: string,
    opts: { waitForRun: boolean },
  ): Promise<IngestionCancellation> {
    const key = { sourceType, sourceId, jobType: INGESTION_PIPELINE_JOB_TYPE };
    if (opts.waitForRun) {
      await acquireJobRunLock(tx, key);
    } else if (!(await tryJobRunLock(tx, key))) {
      return 'run_in_flight';
    }
    return (await consumeIdempotencyKey(tx, key)) ? 'cancelled' : 'already_ran';
  }
}
