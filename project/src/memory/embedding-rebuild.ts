import { randomUUID } from 'node:crypto';
import { and, asc, gt, gte, isNotNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '../infrastructure/index';
import { enqueueDelayedJob, runSingleFlight, writeAudit } from '../infrastructure/index';
import { JOB_PRINCIPAL_KEY } from '../infrastructure/index';
import { ModelBudgetExceededError, ModelGateway } from '../model-gateway/index';
import { memory } from './persistence/tables';
import type { MemoryRow } from './persistence/tables';
import { MemoryVectorStore, memoryPointFor } from './persistence/vector-store';
import {
  acquireEmbeddingWriteLockExclusive,
  readEmbeddingIndexState,
  readEmbeddingIndexStateForUpdate,
  REBUILD_COLLECTION_PREFIX,
  updateEmbeddingIndexState,
} from './embedding-index';

/**
 * The managed embedding rebuild (V2.4 item 7.1, second half; issues A and B
 * of the reindex unit).
 *
 * The whole design serves one constraint: AT EVERY POINT, including after any
 * failure, cancellation or restart, there is a coherent active configuration
 * whose index matches it. The mechanism:
 *
 *  - The corpus is embedded from Postgres (the source of truth, spec 4.2)
 *    into a NEW collection while the old one keeps serving untouched. Resume
 *    state is presence-in-the-target-collection, the same property the
 *    original resumable reindex proved: a restarted pass re-verifies and
 *    continues, and re-delivery of the job is a clean skip under the
 *    single-flight lock.
 *  - The job is the `import.advance` shape: a plain re-runnable pass under a
 *    single-flight advisory lock that does a bounded slice of work, records
 *    progress on the state row, and re-enqueues itself. No pass holds a
 *    worker slot for hours, and a killed pass costs one slice.
 *  - The SWITCH is one transaction, under the exclusive side of the
 *    embedding-write lock: final catch-up, gate-payload resync, orphan sweep,
 *    verification, the per-row model stamp, the providers assignment flip
 *    (through the port the composition root binds), and the state flip. A
 *    crash anywhere rolls the whole thing back to a still-running rebuild
 *    over a still-serving old index.
 *  - Budget exhaustion PAUSES the rebuild (visible, resumes on a delay); it
 *    never bypasses the meter. Repeated real failures park it as 'failed'
 *    with the error shown, and both resume and cancel stay available.
 */

export const EMBEDDING_REBUILD_JOB_TYPE = 'memory.reindex_advance';

/** Single-flight lock name: one rebuild pass per instance, ever. */
const REBUILD_FLIGHT = 'embedding-rebuild';

/** How long one pass works before re-enqueueing (keeps the worker responsive
 * and progress visible without a pass monopolising a concurrency slot). */
const PASS_BUDGET_MS = 40_000;
const BATCH_SIZE = 64;
/** Delay before the next pass; near-continuous without hammering the queue. */
const NEXT_PASS_DELAY_MINUTES = 0.05;
/** An exhausted daily budget retries when the window has had time to move. */
const BUDGET_PAUSE_MINUTES = 30;
/** Consecutive failing passes before the rebuild parks as 'failed'. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** How long a replaced collection keeps existing after the switch, so a
 * process still on the pre-switch configuration (30 s version poll) serves a
 * coherent old space until it catches up. */
const RETIRE_GRACE_MINUTES = 5;

export interface EmbeddingRebuildTarget {
  providerId: string;
  providerLabel: string;
  model: string;
  /** PROBED from a real embedding at plan time, never a registry guess. */
  dimensions: number;
}

export interface EmbeddingRebuildCorpus {
  /** Rows with non-blank content — the ones that carry a vector. */
  facts: number;
  /** ceil(chars / 4): the same accounting the budget meter charges. */
  estimatedTokens: number;
}

/** What the corpus costs to re-embed — the plan half of the confirm dialog. */
export async function embeddingRebuildCorpus(db: Db): Promise<EmbeddingRebuildCorpus> {
  const [row] = (await db
    .select({
      facts: sql<number>`count(*)::int`,
      chars: sql<number>`coalesce(sum(length(${memory.content})), 0)::bigint`,
    })
    .from(memory)
    .where(embeddable())) as [{ facts: number; chars: number }];
  return { facts: row.facts, estimatedTokens: Math.ceil(Number(row.chars) / 4) };
}

function embeddable() {
  return and(isNotNull(memory.content), sql`btrim(${memory.content}) <> ''`);
}

/**
 * Record the pending rebuild and enqueue the first pass. The pending model is
 * deliberately SEPARATE from the active assignment: nothing about the serving
 * configuration changes here, which is what makes cancel/failure trivially
 * safe. Refuses while any rebuild exists — resume and cancel are the verbs
 * for an existing one.
 */
export async function beginEmbeddingRebuild(
  db: Db,
  request: { target: EmbeddingRebuildTarget; requestedBy: string; orgId?: string },
): Promise<void> {
  const rebuildId = randomUUID();
  const collection = `${REBUILD_COLLECTION_PREFIX}${rebuildId.slice(0, 8)}`;
  const corpus = await embeddingRebuildCorpus(db);
  await db.transaction(async (tx) => {
    const state = await readEmbeddingIndexStateForUpdate(tx);
    if (state.rebuildStatus) {
      throw new EmbeddingRebuildConflictError(
        state.rebuildStatus === 'failed'
          ? 'a failed rebuild exists: resume it or cancel it first'
          : 'a rebuild is already running',
      );
    }
    await updateEmbeddingIndexState(tx, {
      rebuildId,
      rebuildStatus: 'running',
      targetProviderId: request.target.providerId,
      targetProviderLabel: request.target.providerLabel,
      targetModel: request.target.model,
      targetCollection: collection,
      targetDimensions: request.target.dimensions,
      factsTotal: corpus.facts,
      factsDone: 0,
      tokensSpent: 0,
      rebuildCursor: null,
      sweepMissing: 0,
      consecutiveFailures: 0,
      rebuildError: null,
      cancelRequested: false,
      requestedBy: request.requestedBy,
      requestedOrg: request.orgId ?? null,
      startedAt: new Date(),
    });
    await enqueueAdvance(tx, rebuildId, request.requestedBy, 0);
    await writeAudit(tx, {
      actor: `user:${request.requestedBy}`,
      action: 'embedding_rebuild.requested',
      entityType: 'embedding_index',
      entityId: rebuildId,
      ...(request.orgId ? { orgId: request.orgId } : {}),
      detail: { model: request.target.model, facts: corpus.facts },
    });
  });
}

/** A failed rebuild back to running; progress already made is kept. */
export async function resumeEmbeddingRebuild(
  db: Db,
  request: { requestedBy: string; orgId?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const state = await readEmbeddingIndexStateForUpdate(tx);
    if (state.rebuildStatus !== 'failed' || !state.rebuildId) {
      throw new EmbeddingRebuildConflictError('there is no failed rebuild to resume');
    }
    await updateEmbeddingIndexState(tx, {
      rebuildStatus: 'running',
      consecutiveFailures: 0,
      rebuildError: null,
    });
    await enqueueAdvance(tx, state.rebuildId, request.requestedBy, 0);
    await writeAudit(tx, {
      actor: `user:${request.requestedBy}`,
      action: 'embedding_rebuild.resumed',
      entityType: 'embedding_index',
      entityId: state.rebuildId,
      ...(request.orgId ? { orgId: request.orgId } : {}),
    });
  });
}

/**
 * Cancel: always available, always clean. Sets the flag first (a running pass
 * checks it between batches), then tries to perform the cleanup right here —
 * if the pass holds the single-flight lock, IT observes the flag and cleans
 * up instead. Either way the partial collection is dropped, the pending state
 * cleared, and the previous configuration was never touched.
 */
export async function cancelEmbeddingRebuild(
  db: Db,
  vectors: MemoryVectorStore,
  request: { requestedBy: string; orgId?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await readEmbeddingIndexStateForUpdate(tx);
    if (!row.rebuildStatus)
      throw new EmbeddingRebuildConflictError('there is no rebuild to cancel');
    await updateEmbeddingIndexState(tx, { cancelRequested: true });
  });
  await runSingleFlight(db, REBUILD_FLIGHT, async () => {
    await cleanupCancelled(db, vectors, `user:${request.requestedBy}`, request.orgId);
  });
}

export class EmbeddingRebuildConflictError extends Error {}

async function enqueueAdvance(
  tx: Db | Tx,
  rebuildId: string,
  principalId: string | null,
  delayMinutes: number,
): Promise<void> {
  await enqueueDelayedJob(
    tx,
    {
      type: EMBEDDING_REBUILD_JOB_TYPE,
      payload: {
        source_type: 'memory',
        source_id: rebuildId,
        ...(principalId ? { [JOB_PRINCIPAL_KEY]: principalId } : {}),
      },
    },
    delayMinutes,
  );
}

/**
 * Worker boot: a live rebuild whose advance job died with the process (or
 * whose graphile lock is still held by a dead worker id) gets a fresh pass
 * enqueued. Duplicates are harmless: passes are single-flight.
 */
export async function resumeEmbeddingRebuildOnBoot(db: Db): Promise<void> {
  const state = await readEmbeddingIndexState(db);
  if (state.rebuildStatus === 'running' && state.rebuildId) {
    await enqueueAdvance(db, state.rebuildId, state.requestedBy, 0);
  } else if (state.retiredCollection) {
    await enqueueAdvance(db, state.rebuildId ?? randomUUID(), null, RETIRE_GRACE_MINUTES);
  }
}

// ── The pass ────────────────────────────────────────────────────────────────

/** The providers-side half of the switch, bound at the composition root:
 * memory cannot import providers (providers imports memory), so the flip of
 * the embeddings assignment travels in as a port. */
export interface EmbeddingSwitchPort {
  /** Flip the stored embeddings assignment INSIDE the switch transaction. */
  commit(
    tx: Tx,
    change: { providerId: string; model: string; changedBy: string | null },
  ): Promise<void>;
  /** After commit: reload the live configuration and record/audit the change. */
  afterCommit(change: {
    providerId: string;
    providerLabel: string;
    model: string;
    changedBy: string | null;
    orgId: string | null;
  }): Promise<void>;
}

export interface EmbeddingRebuildPassDeps {
  db: Db;
  /** The live store serving the active collection; targets are views on it. */
  vectors: MemoryVectorStore;
  /** A gateway bound to the TARGET provider and model, built through the
   * ordinary factory so the budget and audit decorators wrap it. Resolved
   * per pass: a provider deleted mid-rebuild fails the pass loudly. */
  gatewayFor: (target: { providerId: string; model: string }) => Promise<ModelGateway>;
  switchPort: EmbeddingSwitchPort;
  log?: (message: string) => void;
  /** Test overrides. */
  passBudgetMs?: number;
  batchSize?: number;
}

export interface EmbeddingRebuildPassResult {
  ran: boolean;
  outcome: 'idle' | 'advanced' | 'completed' | 'cancelled' | 'failed' | 'paused_budget' | 'retired';
}

/**
 * One bounded pass of the rebuild. Safe to call at any time, from the worker
 * job or the operator CLI: the single-flight lock makes concurrent callers
 * skip, and every step is idempotent.
 */
export async function runEmbeddingRebuildPass(
  deps: EmbeddingRebuildPassDeps,
): Promise<EmbeddingRebuildPassResult> {
  const flight = await runSingleFlight(deps.db, REBUILD_FLIGHT, () => pass(deps));
  if (!flight.ran) return { ran: false, outcome: 'idle' };
  return { ran: true, outcome: flight.result };
}

async function pass(
  deps: EmbeddingRebuildPassDeps,
): Promise<EmbeddingRebuildPassResult['outcome']> {
  const log = deps.log ?? (() => undefined);
  const db = deps.db;
  const state = await readEmbeddingIndexState(db);

  if (!state.rebuildStatus) {
    // No rebuild: the only possible work is dropping a retired collection
    // whose grace period has passed.
    if (state.retiredCollection && state.retiredAt) {
      const graceOver = Date.now() - state.retiredAt.getTime() >= RETIRE_GRACE_MINUTES * 60_000;
      if (graceOver) {
        await deps.vectors.view(state.retiredCollection, 1).deleteCollectionIfExists();
        await updateEmbeddingIndexState(db, { retiredCollection: null, retiredAt: null });
        log(`retired collection ${state.retiredCollection} dropped`);
        return 'retired';
      }
      await enqueueAdvance(db, state.rebuildId ?? randomUUID(), null, RETIRE_GRACE_MINUTES);
    }
    return 'idle';
  }
  if (state.cancelRequested) {
    await cleanupCancelled(db, deps.vectors, 'worker:embedding-rebuild');
    return 'cancelled';
  }
  if (state.rebuildStatus === 'failed') return 'idle';
  if (
    !state.rebuildId ||
    !state.targetCollection ||
    !state.targetModel ||
    !state.targetProviderId ||
    !state.targetDimensions
  ) {
    // A malformed state row is not something a retry fixes.
    await updateEmbeddingIndexState(db, {
      rebuildStatus: 'failed',
      rebuildError: 'rebuild state is incomplete; cancel and start again',
    });
    return 'failed';
  }

  const target = deps.vectors.view(state.targetCollection, state.targetDimensions);
  try {
    // Same creation path as boot: dimensions AND the gate payload indexes.
    await target.ensureCollection();
    const gateway = await deps.gatewayFor({
      providerId: state.targetProviderId,
      model: state.targetModel,
    });

    const outcome = await advanceScan(deps, state.rebuildId, target, gateway, log);
    if (outcome === 'sweep_clean') {
      await finalizeSwitch(deps, target, log);
      return 'completed';
    }
    // Progress made and budget spent: hand the slot back and continue shortly.
    await updateEmbeddingIndexState(db, { consecutiveFailures: 0 });
    await enqueueAdvance(db, state.rebuildId, state.requestedBy, NEXT_PASS_DELAY_MINUTES);
    return 'advanced';
  } catch (error) {
    if (error instanceof ModelBudgetExceededError) {
      // Paused, not bypassed: the meter is the meter. Visible on the state
      // row; resumes when the daily window has had time to move.
      await updateEmbeddingIndexState(db, {
        rebuildError: 'daily model budget exhausted; the rebuild resumes automatically',
      });
      await enqueueAdvance(db, state.rebuildId, state.requestedBy, BUDGET_PAUSE_MINUTES);
      log('rebuild paused: daily model budget exhausted');
      return 'paused_budget';
    }
    const failures = (state.consecutiveFailures ?? 0) + 1;
    const message = error instanceof Error ? error.message : String(error);
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      await updateEmbeddingIndexState(db, {
        rebuildStatus: 'failed',
        consecutiveFailures: failures,
        rebuildError: message.slice(0, 500),
      });
      await writeAudit(db, {
        actor: 'worker:embedding-rebuild',
        action: 'embedding_rebuild.failed',
        entityType: 'embedding_index',
        entityId: state.rebuildId,
        detail: { failures },
      });
      log(`rebuild parked as failed after ${failures} passes: ${message}`);
      return 'failed';
    }
    await updateEmbeddingIndexState(db, {
      consecutiveFailures: failures,
      rebuildError: message.slice(0, 500),
    });
    await enqueueAdvance(db, state.rebuildId, state.requestedBy, Math.min(failures * failures, 30));
    log(`rebuild pass failed (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${message}`);
    return 'failed';
  }
}

/**
 * The scan slice: walk the corpus by keyset from the persisted cursor,
 * embedding whatever the target collection is missing. A sweep that reaches
 * the end having found nothing missing proves the target complete — rows
 * ingested mid-rebuild are caught because the next sweep starts over.
 */
async function advanceScan(
  deps: EmbeddingRebuildPassDeps,
  rebuildId: string,
  target: MemoryVectorStore,
  gateway: ModelGateway,
  log: (message: string) => void,
): Promise<'sweep_clean' | 'budget_spent'> {
  const db = deps.db;
  const batchSize = deps.batchSize ?? BATCH_SIZE;
  const deadline = Date.now() + (deps.passBudgetMs ?? PASS_BUDGET_MS);
  let state = await readEmbeddingIndexState(db);
  let cursor = state.rebuildCursor;
  let sweepMissing = state.sweepMissing ?? 0;
  let tokensSpent = state.tokensSpent ?? 0;

  while (Date.now() < deadline) {
    // Cancellation is checked every batch, so cancel latency is one batch.
    if ((await readEmbeddingIndexState(db)).cancelRequested) return 'budget_spent';
    const rows: MemoryRow[] = await db
      .select()
      .from(memory)
      .where(cursor ? and(embeddable(), gt(memory.id, cursor)) : embeddable())
      .orderBy(asc(memory.id))
      .limit(batchSize);

    if (rows.length === 0) {
      if (cursor !== null && sweepMissing === 0) {
        await updateEmbeddingIndexState(db, { rebuildCursor: null, sweepMissing: 0 });
        return 'sweep_clean';
      }
      // Sweep done but it found work (or the corpus is empty as scanned from
      // the top): start the next sweep from the top.
      if (cursor === null && sweepMissing === 0) return 'sweep_clean';
      cursor = null;
      sweepMissing = 0;
      await updateEmbeddingIndexState(db, { rebuildCursor: null, sweepMissing: 0 });
      continue;
    }

    cursor = rows[rows.length - 1]!.id;
    const present = await target.retrieveVectors(rows.map((row) => row.id));
    const missing = rows.filter((row) => !present.has(row.id));
    if (missing.length > 0) {
      const texts = missing.map((row) => row.content as string);
      const vectors = await gateway.embed(texts);
      await target.upsert(missing.map((row, i) => memoryPointFor(row, vectors[i]!)));
      tokensSpent += Math.ceil(texts.reduce((sum, text) => sum + text.length, 0) / 4);
      sweepMissing += missing.length;
    }
    const done = await target.count();
    await updateEmbeddingIndexState(db, {
      rebuildCursor: cursor,
      sweepMissing,
      factsDone: done,
      tokensSpent,
    });
    log(`rebuild progress ${done}/${state.factsTotal ?? '?'} (${missing.length} embedded)`);
    state = await readEmbeddingIndexState(db);
  }
  return 'budget_spent';
}

/**
 * The switch: ONE transaction under the exclusive embedding-write lock.
 * Everything in here either all happens or none of it does, which is the
 * whole atomicity story — a crash at any line leaves a running rebuild over
 * an untouched serving index.
 */
async function finalizeSwitch(
  deps: EmbeddingRebuildPassDeps,
  target: MemoryVectorStore,
  log: (message: string) => void,
): Promise<void> {
  const db = deps.db;
  interface CompletedSwitch {
    rebuildId: string;
    providerId: string;
    providerLabel: string;
    model: string;
    requestedBy: string | null;
    requestedOrg: string | null;
    facts: number;
  }

  const completed = await db.transaction(async (tx): Promise<CompletedSwitch | null> => {
    // Excludes every stage-5 / embed-job writer for the duration: no fact can
    // be embedded under the old model and committed after our catch-up.
    await acquireEmbeddingWriteLockExclusive(tx);
    const state = await readEmbeddingIndexStateForUpdate(tx);
    if (state.rebuildStatus !== 'running' || state.cancelRequested) return null;
    if (!state.targetProviderId || !state.targetModel || !state.targetCollection) return null;
    const gateway = await deps.gatewayFor({
      providerId: state.targetProviderId,
      model: state.targetModel,
    });

    // Final catch-up: rows the sweeps never saw (ingested moments ago).
    const embeddableIds = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const rows: MemoryRow[] = await tx
        .select()
        .from(memory)
        .where(cursor ? and(embeddable(), gt(memory.id, cursor)) : embeddable())
        .orderBy(asc(memory.id))
        .limit(256);
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.id;
      for (const row of rows) embeddableIds.add(row.id);
      const present = await target.retrieveVectors(rows.map((row) => row.id));
      const missing = rows.filter((row) => !present.has(row.id));
      if (missing.length > 0) {
        const vectors = await gateway.embed(missing.map((row) => row.content as string));
        await target.upsert(missing.map((row, i) => memoryPointFor(row, vectors[i]!)));
      }
    }

    // Gate-payload resync: rows whose status/scope/sensitive/validity moved
    // during the rebuild. Content never mutates (editing is supersession), so
    // vectors cannot be stale — only payloads can, and only for rows touched
    // since the start. The slack absorbs clock skew around `started_at`.
    const touchedSince = new Date((state.startedAt?.getTime() ?? 0) - 60_000);
    const touched: MemoryRow[] = await tx
      .select()
      .from(memory)
      .where(and(embeddable(), gte(memory.updatedAt, touchedSince)));
    for (const row of touched) {
      const point = memoryPointFor(row, []);
      await target.setPayload(row.id, point.payload);
    }

    // Orphan sweep: points whose row vanished mid-rebuild (rolled-back
    // pipeline attempt, deletion whose dual-apply raced collection creation).
    const orphans = (await target.listPointIds()).filter((id) => !embeddableIds.has(id));
    await target.deletePoints(orphans);

    const pointCount = await target.count();
    if (pointCount !== embeddableIds.size) {
      throw new Error(
        `rebuild verification failed: ${pointCount} points vs ${embeddableIds.size} embeddable memories`,
      );
    }

    // The stamp: every embedded row now records the target as its producer.
    await tx
      .update(memory)
      .set({ embeddingModel: state.targetModel })
      .where(
        and(embeddable(), sql`${memory.embeddingModel} IS DISTINCT FROM ${state.targetModel}`),
      );

    // The assignment flip, in the same transaction, through the port.
    await deps.switchPort.commit(tx, {
      providerId: state.targetProviderId,
      model: state.targetModel,
      changedBy: state.requestedBy,
    });

    await updateEmbeddingIndexState(tx, {
      activeCollection: state.targetCollection,
      activeDimensions: state.targetDimensions,
      retiredCollection: state.activeCollection,
      retiredAt: new Date(),
      rebuildId: null,
      rebuildStatus: null,
      targetProviderId: null,
      targetProviderLabel: null,
      targetModel: null,
      targetCollection: null,
      targetDimensions: null,
      factsTotal: null,
      factsDone: null,
      tokensSpent: state.tokensSpent,
      rebuildCursor: null,
      sweepMissing: null,
      consecutiveFailures: 0,
      rebuildError: null,
      requestedBy: null,
      requestedOrg: null,
      startedAt: null,
    });
    return {
      rebuildId: state.rebuildId!,
      providerId: state.targetProviderId,
      providerLabel: state.targetProviderLabel ?? state.targetProviderId,
      model: state.targetModel,
      requestedBy: state.requestedBy,
      requestedOrg: state.requestedOrg,
      facts: pointCount,
    };
  });

  if (!completed) return;
  const done = completed;
  // Post-commit: reload the live configuration (this process immediately;
  // every other within one version poll) and record the change.
  await deps.switchPort.afterCommit({
    providerId: done.providerId,
    providerLabel: done.providerLabel,
    model: done.model,
    changedBy: done.requestedBy,
    orgId: done.requestedOrg,
  });
  await writeAudit(db, {
    actor: done.requestedBy ? `user:${done.requestedBy}` : 'worker:embedding-rebuild',
    action: 'embedding_rebuild.completed',
    entityType: 'embedding_index',
    entityId: done.rebuildId,
    ...(done.requestedOrg ? { orgId: done.requestedOrg } : {}),
    detail: { facts: done.facts },
  });
  // The replaced collection outlives the switch by a grace period, then a
  // later pass drops it.
  await enqueueAdvance(db, done.rebuildId, null, RETIRE_GRACE_MINUTES);
  log(`rebuild complete: switched to ${done.model} (${done.facts} facts)`);
}

async function cleanupCancelled(
  db: Db,
  vectors: MemoryVectorStore,
  actor: string,
  orgId?: string,
): Promise<void> {
  const state = await readEmbeddingIndexState(db);
  if (!state.cancelRequested || !state.rebuildStatus) return;
  if (state.targetCollection) {
    await vectors
      .view(state.targetCollection, state.targetDimensions ?? 1)
      .deleteCollectionIfExists();
  }
  await updateEmbeddingIndexState(db, {
    rebuildId: null,
    rebuildStatus: null,
    targetProviderId: null,
    targetProviderLabel: null,
    targetModel: null,
    targetCollection: null,
    targetDimensions: null,
    factsTotal: null,
    factsDone: null,
    tokensSpent: null,
    rebuildCursor: null,
    sweepMissing: null,
    consecutiveFailures: 0,
    rebuildError: null,
    cancelRequested: false,
    requestedBy: null,
    requestedOrg: null,
    startedAt: null,
  });
  await writeAudit(db, {
    actor,
    action: 'embedding_rebuild.cancelled',
    entityType: 'embedding_index',
    entityId: state.rebuildId ?? 'unknown',
    ...(orgId ? { orgId } : {}),
  });
}
