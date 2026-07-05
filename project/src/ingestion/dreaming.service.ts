import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { DRIZZLE, writeAudit } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import { MemoryStore } from '../memory/index';
import type { MemoryRow } from '../memory/index';
import { dormantFlag, dreamAction, dreamRun } from './persistence/tables';
import type { DreamPass, DreamRunRow } from './persistence/tables';
import { ReconciliationService } from './pipeline/reconcile.stage';
import type { ReconcileActionRecord, ReconcileInput } from './pipeline/reconcile.stage';
import { noopLog } from './pipeline/pipeline-log';
import type { PipelineLog } from './pipeline/pipeline-log';
import { DORMANT_SILENCE_DAYS, DREAM_FIRST_RUN_LOOKBACK_HOURS } from './reconcile-config';

/**
 * The dreaming cycle (§B.6 plain form; decision 0011): the nightly
 * consolidation job. Incremental — the scope window runs from the last
 * FINISHED run to now, covering the day's newly admitted facts and the
 * memories they touched, never the whole store. Four passes:
 *
 *   1–3. batch dedup / contradiction / supersession — the SAME
 *        ReconciliationService stage 6 uses (0010 ruling 1), per owner, in a
 *        per-owner transaction. Catches what the per-source view missed:
 *        approved-since-admission facts, edited memories, deeper candidates.
 *   4a.  staleness — deterministic and model-free: every active memory whose
 *        valid_until has lapsed transitions to `outdated` as the
 *        consolidation actor (the matrix's owner of `outdated`; dreaming IS
 *        the consolidation job — glossary).
 *   4b.  dormant flags — active commitments quiet beyond the silence window
 *        are FLAGGED (dormant_flag, never a transition) for the digest and
 *        the F3 task engine; flags whose memory left `active` are cleared.
 *
 * Idempotent by construction (the 0010 ruling 7 mechanisms plus the unique
 * open-flag index and the staleness status filter); resumable — a crashed run
 * leaves finished_at NULL and the next run re-covers its window.
 */

// Underscore, not a dot: graphile's crontab parser rejects dots in task names.
export const DREAM_JOB_TYPE = 'dreaming_cycle';
/** 03:30 nightly — after the 03:00 integrity sweep (F1 scheduler infra). */
export const DREAM_CRONTAB = `30 3 * * * ${DREAM_JOB_TYPE}`;

export interface DreamReport {
  runId: string;
  scopeFrom: string;
  scopeTo: string;
  ownersProcessed: number;
  considered: number;
  merged: number;
  enriched: number;
  contradictions: number;
  superseded: number;
  outdated: number;
  dormantFlagged: number;
  flagsCleared: number;
}

@Injectable()
export class DreamingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly memoryStore: MemoryStore,
    private readonly reconciliationService: ReconciliationService,
  ) {}

  async run(log: PipelineLog = noopLog, opts: { scopeFrom?: Date } = {}): Promise<DreamReport> {
    const now = new Date();
    const scopeFrom = opts.scopeFrom ?? (await this.defaultScopeFrom(now));
    const [run] = await this.db
      .insert(dreamRun)
      .values({ scopeFrom, scopeTo: now, startedAt: now })
      .returning();
    const runId = run!.id;

    const report: DreamReport = {
      runId,
      scopeFrom: scopeFrom.toISOString(),
      scopeTo: now.toISOString(),
      ownersProcessed: 0,
      considered: 0,
      merged: 0,
      enriched: 0,
      contradictions: 0,
      superseded: 0,
      outdated: 0,
      dormantFlagged: 0,
      flagsCleared: 0,
    };

    // ── Passes 1–3: batch reconciliation per owner ──────────────────────────
    const touched = await this.memoryStore.listTouchedBetween(scopeFrom, now);
    const byOwner = new Map<string, MemoryRow[]>();
    for (const row of touched) {
      byOwner.set(row.ownerId, [...(byOwner.get(row.ownerId) ?? []), row]);
    }
    for (const [ownerId, rows] of byOwner) {
      const embeddings = await this.memoryStore.retrieveEmbeddings(rows.map((r) => r.id));
      const items: ReconcileInput[] = rows
        .filter((row) => embeddings.has(row.id))
        .map((row) => ({ row, embedding: embeddings.get(row.id)! }));
      if (items.length === 0) continue;
      report.ownersProcessed += 1;
      const summary = await this.db.transaction(async (tx) => {
        const result = await this.reconciliationService.reconcile(tx, items, log);
        await this.recordReconcileActions(tx, runId, result.actions);
        return result;
      });
      report.considered += summary.considered;
      report.merged += summary.merged;
      report.enriched += summary.enriched;
      report.contradictions += summary.contradictions;
      report.superseded += summary.superseded;
      log(
        { stage: 'dream', owner: ownerId, ...{ ...summary, actions: undefined } },
        'dreaming: owner batch reconciled',
      );
    }

    // ── Pass 4a: staleness — deterministic, zero model calls ────────────────
    const lapsed = await this.memoryStore.listLapsedActive(now);
    for (const row of lapsed) {
      await this.memoryStore.transition(
        { kind: 'consolidation' },
        row.id,
        'outdated',
        'dreaming staleness pass: valid_until lapsed',
      );
      await this.db.insert(dreamAction).values({ runId, pass: 'staleness', memoryId: row.id });
      report.outdated += 1;
    }

    // ── Pass 4b: dormant flags (flag, never transition) ─────────────────────
    const quietBefore = new Date(now.getTime() - DORMANT_SILENCE_DAYS * 24 * 3600 * 1000);
    const quiet = await this.memoryStore.listQuietCommitments(quietBefore);
    for (const row of quiet) {
      const inserted = await this.db
        .insert(dormantFlag)
        .values({ memoryId: row.id, runId, reason: `no activity for ${DORMANT_SILENCE_DAYS} days` })
        .onConflictDoNothing()
        .returning({ id: dormantFlag.id });
      if (inserted.length > 0) {
        await this.db.insert(dreamAction).values({ runId, pass: 'dormant', memoryId: row.id });
        report.dormantFlagged += 1;
      }
    }
    report.flagsCleared = await this.clearSettledFlags();

    const finishedAt = new Date();
    await this.db
      .update(dreamRun)
      .set({ finishedAt, countsJson: { ...report, runId: undefined } })
      .where(eq(dreamRun.id, runId));
    await writeAudit(this.db, {
      actor: 'consolidation',
      action: 'dreaming.completed',
      entityType: 'dream_run',
      entityId: runId,
      detail: { ...report },
    });
    log({ stage: 'dream', ...report }, 'dreaming cycle completed');
    return report;
  }

  /** Watermark: the last FINISHED run's window end; first run looks back 24h. */
  private async defaultScopeFrom(now: Date): Promise<Date> {
    const last = await this.db
      .select()
      .from(dreamRun)
      .where(isNotNull(dreamRun.finishedAt))
      .orderBy(desc(dreamRun.finishedAt))
      .limit(1);
    return (
      last[0]?.scopeTo ?? new Date(now.getTime() - DREAM_FIRST_RUN_LOOKBACK_HOURS * 3600 * 1000)
    );
  }

  private async recordReconcileActions(
    tx: Tx,
    runId: string,
    actions: ReconcileActionRecord[],
  ): Promise<void> {
    for (const { factId, candidateId, result } of actions) {
      let pass: DreamPass;
      let memoryId: string;
      let relatedMemoryId: string | null = candidateId;
      let relationId: string | null = null;
      if (result.action === 'merged') {
        pass = 'dedup';
        memoryId = result.survivorId;
        relatedMemoryId = result.loserId;
      } else if (result.action === 'superseded') {
        pass = 'supersession';
        memoryId = result.winnerId;
        relatedMemoryId = result.loserId;
      } else if (result.action === 'contradiction_created') {
        pass = 'contradiction';
        memoryId = factId;
        relationId = result.relationId;
      } else {
        continue; // skipped results are never recorded
      }
      await tx.insert(dreamAction).values({ runId, pass, memoryId, relatedMemoryId, relationId });
    }
  }

  /** Flags whose memory resolved, superseded, or vanished are done. */
  private async clearSettledFlags(): Promise<number> {
    const open = await this.db.select().from(dormantFlag).where(isNull(dormantFlag.clearedAt));
    if (open.length === 0) return 0;
    const rows = await this.memoryStore.getManySystem(open.map((f) => f.memoryId));
    const activeIds = new Set(rows.filter((r) => r.status === 'active').map((r) => r.id));
    let cleared = 0;
    for (const flag of open) {
      if (activeIds.has(flag.memoryId)) continue;
      await this.db
        .update(dormantFlag)
        .set({ clearedAt: new Date() })
        .where(eq(dormantFlag.id, flag.id));
      cleared += 1;
    }
    return cleared;
  }
}

/** The latest finished run — the digest endpoint's anchor. */
export async function latestFinishedRun(db: Db): Promise<DreamRunRow | null> {
  const rows = await db
    .select()
    .from(dreamRun)
    .where(isNotNull(dreamRun.finishedAt))
    .orderBy(desc(dreamRun.finishedAt))
    .limit(1);
  return rows[0] ?? null;
}
