import { Inject, Injectable, Optional } from '@nestjs/common';
import { DRIZZLE, enqueueDelayedJob } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { MemorySystemStore } from '../memory/index';
import type { MemoryEligibilityHook, MemoryRow } from '../memory/index';
import type { SourceTypeKey } from '@cogeto/shared';
import { ReconciliationService } from './pipeline/reconcile.stage';
import type { ReconcileInput, ReconcileSummary } from './pipeline/reconcile.stage';
import { noopLog } from './pipeline/pipeline-log';
import type { PipelineLog } from './pipeline/pipeline-log';
import { REPAIR_DELAY_MINUTES } from './reconcile-config';

/**
 * The reconcile repair pass (V2.3 item 6.1, issue B): the timing misses the
 * inline pass structurally cannot cover.
 *
 * - **Near-simultaneous ingestion**: two documents uploaded together run as
 *   two jobs whose transactions cannot see each other's uncommitted rows, so
 *   their facts never pair inline and used to wait for the nightly cycle.
 *   The pipeline enqueues one repair per source, a few minutes after commit;
 *   by then the neighbour's rows are visible, and the checked-pair ledger
 *   makes the re-run cheap (already-judged pairs are skipped wholesale).
 * - **Eligibility changes**: an `uncertain` fact is excluded from
 *   contradiction checks until confirmed. Confirming it used to change
 *   nothing until the nightly pass; the memory module's eligibility port now
 *   lands here, and the confirmed fact is re-paired within minutes.
 *
 * Idempotent by construction: the reconcile engine's own re-delivery
 * guarantees (tombstoned relations, replaced losers leaving candidate pools,
 * the ledger) make a duplicate repair a no-op, so the job needs no
 * idempotency wrapper — the dreaming precedent.
 */

export const RECONCILE_REPAIR_JOB_TYPE = 'reconcile.repair';

export interface ReconcileRepairPayload {
  source_type: string;
  source_id: string;
  /** Set when one specific memory's eligibility changed (the approve hook). */
  memory_id?: string;
}

@Injectable()
export class ReconcileRepair {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    /** The unscoped read the repair batch needs; worker root only. */
    private readonly systemMemories: MemorySystemStore,
    private readonly reconciliationService: ReconciliationService,
  ) {}

  async run(
    payload: ReconcileRepairPayload,
    log: PipelineLog = noopLog,
  ): Promise<ReconcileSummary> {
    const rows = payload.memory_id
      ? await this.systemMemories.getManySystem([payload.memory_id])
      : await this.systemMemories.listBySourceSystem(
          payload.source_type as SourceTypeKey,
          payload.source_id,
        );
    const live = rows.filter((row) => row.status === 'active' || row.status === 'uncertain');
    const embeddings = await this.systemMemories.retrieveEmbeddings(live.map((r) => r.id));
    const items: ReconcileInput[] = live
      .filter((row) => embeddings.has(row.id))
      .map((row) => ({ row, embedding: embeddings.get(row.id)! }));
    if (items.length === 0) {
      return {
        considered: 0,
        dedupChecks: 0,
        contradictionChecks: 0,
        ledgerHits: 0,
        deterministicChecks: 0,
        merged: 0,
        enriched: 0,
        contradictions: 0,
        reopened: 0,
        superseded: 0,
        resolvedByRevision: 0,
        actions: [],
      };
    }
    return this.db.transaction(async (tx) =>
      this.reconciliationService.reconcile(tx, items, log, {
        exclude: 'same_source',
        detectedBy: 'repair',
      }),
    );
  }
}

/**
 * Ingestion's implementation of the memory module's eligibility port: a fact
 * whose status change made it contradiction-eligible is re-paired by a
 * repair job, enqueued immediately. Bound at the composition roots.
 */
@Injectable()
export class ReconcileRepairEligibilityHook implements MemoryEligibilityHook {
  constructor(@Inject(DRIZZLE) @Optional() private readonly db?: Db) {}

  async onEligibilityChanged(row: MemoryRow): Promise<void> {
    if (!this.db) return;
    await enqueueDelayedJob(
      this.db,
      {
        type: RECONCILE_REPAIR_JOB_TYPE,
        payload: {
          source_type: row.sourceType,
          source_id: row.sourceId,
          memory_id: row.id,
        },
      },
      0,
    );
  }
}

/** The pipeline's post-commit enqueue: one repair per source, delayed. */
export async function enqueueSourceRepair(
  tx: Db | Parameters<typeof enqueueDelayedJob>[0],
  sourceType: string,
  sourceId: string,
): Promise<void> {
  await enqueueDelayedJob(
    tx,
    { type: RECONCILE_REPAIR_JOB_TYPE, payload: { source_type: sourceType, source_id: sourceId } },
    REPAIR_DELAY_MINUTES,
  );
}
