import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Principal } from '@cogeto/shared';
import { DRIZZLE, enqueueDelayedJob, jobRunStates, runSingleFlight } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { MemoryObjectStore, MemoryReconciliation, MemoryStore } from '../memory/index';
import { FilesService, LadderedDocumentReader, readOutcomesForKeys } from '../files/index';
import {
  INGESTION_PIPELINE_JOB_TYPE,
  refusalsForSources,
  revisionCountsForSuccessors,
  SourceContextStore,
  SourceRevisionStore,
  normalizeFilename,
  scoreRevision,
  shingleSimilarity,
  subjectOverlap,
} from '../ingestion/index';
import { importItem, importRun } from './persistence/tables';
import type { ImportItemRow, ImportRunRow } from './persistence/tables';
import {
  IMPORT_ADVANCE_JOB_TYPE,
  IMPORT_IN_FLIGHT,
  IMPORT_IN_FLIGHT_DEFAULT,
  IMPORT_PIPELINE_PRIORITY,
} from './import-jobs';

/** Seconds between coordinator passes while work is in flight. */
const ADVANCE_INTERVAL_SECONDS = 6;
/** Minutes between passes while paused on the daily upload cap. */
const CAP_PAUSE_MINUTES = 30;

/** Read outcomes that mean the document produced no text. */
const UNREAD_OUTCOMES = ['empty', 'unsupported_format', 'read_failed', 'needs_vision'];

/**
 * The import coordinator (V2.2 item 5.3): a re-runnable worker pass that
 * reaps settled documents, tops the queue up to the in-flight cap, runs the
 * conservative revision linker over settled candidates, and finalizes with
 * the summary's real numbers. Every ingestion goes through the ONE existing
 * upload path (`FilesService.upload`) at demoted queue priority, so the gate,
 * the budgets and the per-user daily caps apply exactly as for a single
 * upload — an import that exhausts the day's quota PAUSES, visibly, rather
 * than bypassing it.
 *
 * Resumable by construction: all state is rows; a restart re-runs the pass
 * and continues; a file that fails, fails alone with its reason.
 */
@Injectable()
export class ImportCoordinator {
  private readonly logger = new Logger(ImportCoordinator.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly files: FilesService,
    private readonly objects: MemoryObjectStore,
    private readonly memory: MemoryStore,
    private readonly reconciliation: MemoryReconciliation,
    private readonly contexts: SourceContextStore,
    private readonly revisions: SourceRevisionStore,
    private readonly reader: LadderedDocumentReader,
    /** The in-flight cap; the composition root maps the env knob. */
    @Optional() @Inject(IMPORT_IN_FLIGHT) private readonly inFlightCap?: number,
  ) {}

  async advance(runId: string): Promise<{ advanced: boolean }> {
    const outcome = await runSingleFlight(this.db, `import:${runId}`, async () => {
      await this.pass(runId);
    });
    return { advanced: outcome.ran };
  }

  private async pass(runId: string): Promise<void> {
    const runs = await this.db.select().from(importRun).where(eq(importRun.id, runId)).limit(1);
    const run = runs[0];
    if (!run) return;
    const principal = principalFor(run);

    // 1. Reap: queued items whose pipeline settled become ingested/failed,
    // and freshly settled revision candidates go through the linker.
    const queued = await this.itemsIn(runId, ['queued']);
    if (queued.length > 0) {
      const states = await jobRunStates(
        this.db,
        queued.map((item) => ({ sourceType: 'file', sourceId: item.objectKey! })),
        INGESTION_PIPELINE_JOB_TYPE,
      );
      for (const item of queued) {
        const state = states.get(`file ${item.objectKey!}`);
        if (state === 'done') {
          await this.setItem(item.id, { state: 'ingested' });
          if (item.revisionOf) await this.linkRevision(principal, run, item);
        } else if (state === 'failed') {
          await this.setItem(item.id, { state: 'failed', reason: 'pipeline_failed' });
        }
      }
    }

    if (run.state === 'cancelled') {
      await this.cleanupStaging(runId);
      await this.finalize(run, principal);
      return;
    }
    if (run.state !== 'running') return;

    // 2. Top up to the in-flight cap through the ONE upload path.
    const cap = this.inFlightCap ?? IMPORT_IN_FLIGHT_DEFAULT;
    const inFlight = (await this.itemsIn(runId, ['queued'])).length;
    let paused = false;
    if (inFlight < cap) {
      const staged = (await this.itemsIn(runId, ['listed'])).filter((item) => item.stagingKey);
      for (const item of staged.slice(0, cap - inFlight)) {
        paused = !(await this.ingestOne(principal, run, item));
        if (paused) break;
      }
    }
    await this.setPaused(run, paused ? 'daily_upload_limit' : null);

    // 3. Finalize or reschedule.
    const remaining = await this.itemsIn(runId, ['listed', 'queued']);
    if (remaining.length === 0) {
      await this.finalize(run, principal);
      return;
    }
    await enqueueDelayedJob(
      this.db,
      { type: IMPORT_ADVANCE_JOB_TYPE, payload: { source_type: 'import_run', source_id: runId } },
      paused ? CAP_PAUSE_MINUTES : ADVANCE_INTERVAL_SECONDS / 60,
    );
  }

  /** One item through the normal upload path; false = the daily cap paused us. */
  private async ingestOne(
    principal: Principal,
    run: ImportRunRow,
    item: ImportItemRow,
  ): Promise<boolean> {
    try {
      const staged = await this.objects.getObject(item.stagingKey!);
      const { objectKey } = await this.files.upload(
        principal,
        {
          buffer: staged.body,
          originalName: item.name ?? 'imported-file',
          mimeType: staged.contentType ?? 'application/octet-stream',
        },
        // The run's confirm-time choice (issue #490); a run confirmed before
        // the choice existed carries none and keeps the 'private' it ran as.
        {
          scope: run.optionsJson?.scope ?? 'private',
          sensitive: run.optionsJson?.sensitive ?? false,
          discard: false,
        },
        { jobPriority: IMPORT_PIPELINE_PRIORITY },
      );
      await this.setItem(item.id, { state: 'queued', objectKey });
      await this.objects.deleteObject(item.stagingKey!).catch(() => undefined);
      await this.setItem(item.id, { stagingKey: null });
      return true;
    } catch (error) {
      const status = (error as { getStatus?: () => number }).getStatus?.();
      if (status === 429) return false; // the daily cap: pause, never bypass
      this.logger.warn(`import item failed to ingest: ${(error as Error).message}`);
      await this.setItem(item.id, {
        state: 'failed',
        reason: status === 400 ? 'rejected_at_upload' : 'ingest_failed',
      });
      return true;
    }
  }

  /**
   * The conservative linker (docs/features/revisions.md), run once per
   * settled candidate: S1 from both anchoring contexts; S2 additionally
   * needs both texts, re-read ONCE through the laddered reader (a discarded
   * predecessor cannot be re-read — then S2 is unavailable and nothing
   * links, the safe direction). Below the bar, nothing is recorded.
   */
  private async linkRevision(
    principal: Principal,
    run: ImportRunRow,
    item: ImportItemRow,
  ): Promise<void> {
    try {
      const successorKey = item.objectKey!;
      const predecessorKey = item.revisionOf!;
      const [succCtx, predCtx] = await Promise.all([
        this.contexts.get(this.db, 'file', successorKey),
        this.contexts.get(this.db, 'file', predecessorKey),
      ]);
      const basis = {
        filename: item.name ? normalizeFilename(item.name) : null,
        revisionNew: succCtx?.revision ?? null,
        revisionOld: predCtx?.revision ?? null,
        subjectOverlap:
          succCtx && predCtx
            ? subjectOverlap(
                succCtx.subjects.filter((s) => s.confident).map((s) => s.name),
                predCtx.subjects.filter((s) => s.confident).map((s) => s.name),
              )
            : null,
        classMatch:
          succCtx?.documentClass && predCtx?.documentClass
            ? succCtx.documentClass === predCtx.documentClass
            : null,
        shingleSimilarity: null as number | null,
      };
      // S2's expensive leg runs only when its cheap legs already hold.
      let score = scoreRevision(basis);
      if (!score && (basis.subjectOverlap ?? 0) >= 0.5 && basis.classMatch === true) {
        basis.shingleSimilarity = await this.structuralSimilarity(
          principal,
          successorKey,
          predecessorKey,
        );
        score = scoreRevision(basis);
      }
      if (!score) return;
      const recorded = await this.revisions.recordDetected(this.db, {
        ownerId: principal.userId,
        successor: { sourceType: 'file', sourceId: successorKey },
        predecessor: { sourceType: 'file', sourceId: predecessorKey },
        status: score.decision,
        basis: { ...basis, confidence: score.confidence },
      });
      if (recorded) {
        this.logger.log(
          `revision ${score.decision} (${score.confidence}) recorded for one imported document`,
        );
      }
    } catch (error) {
      // Linking is metadata: a failure here never fails the import.
      this.logger.warn(`revision detection failed for one item: ${(error as Error).message}`);
    }
  }

  private async structuralSimilarity(
    principal: Principal,
    successorKey: string,
    predecessorKey: string,
  ): Promise<number | null> {
    try {
      const [a, b] = await Promise.all([
        this.objects.getObject(successorKey),
        this.objects.getObject(predecessorKey),
      ]);
      const [textA, textB] = await Promise.all([
        this.reader.read(principal.userId, a.body, a.contentType, null),
        this.reader.read(principal.userId, b.body, b.contentType, null),
      ]);
      return shingleSimilarity(textA.text, textB.text);
    } catch {
      return null; // an unreadable side corroborates nothing
    }
  }

  /** The summary's real numbers, computed from the stores that own them. */
  private async finalize(run: ImportRunRow, principal: Principal): Promise<void> {
    const items = await this.db.select().from(importItem).where(eq(importItem.runId, run.id));
    const by = (state: ImportItemRow['state']) =>
      items.filter((item) => item.state === state).length;
    const ingested = items.filter((item) => item.state === 'ingested' && item.objectKey !== null);
    const refs = ingested.map((item) => ({ sourceType: 'file', sourceId: item.objectKey! }));
    const keys = ingested.map((item) => item.objectKey!);
    const [factStats, contradictions, outcomes, refusals, revisions] = await Promise.all([
      this.memory.sourceFactStatsForRefs(principal, refs),
      this.reconciliation.openContradictionCountsForSources(principal, refs),
      readOutcomesForKeys(this.db, keys),
      refusalsForSources(this.db, refs),
      revisionCountsForSuccessors(this.db, keys),
    ]);
    let facts = 0;
    let superseded = 0;
    for (const stat of factStats.values()) {
      facts += stat.facts;
      superseded += stat.superseded;
    }
    let contradictionCount = 0;
    for (const n of contradictions.values()) contradictionCount += n;
    const unreadable = keys.filter((key) =>
      UNREAD_OUTCOMES.includes(outcomes.get(key)?.outcome ?? ''),
    ).length;
    const truncated = keys.filter((key) => outcomes.get(key)?.outcome === 'truncated').length;

    const counts = {
      documents: ingested.length,
      facts,
      contradictions: contradictionCount,
      superseded,
      duplicatesSkipped: by('duplicate'),
      revisionsLinked: revisions.linked,
      revisionsProposed: revisions.proposed,
      unreadable,
      gated: refusals.size,
      truncated,
      failed: by('failed'),
      excluded: by('excluded'),
      unsupported: by('unsupported'),
      cancelled: by('cancelled'),
    };
    await this.db
      .update(importRun)
      .set({
        countsJson: counts,
        state: run.state === 'cancelled' ? 'cancelled' : 'completed',
        finishedAt: new Date(),
      })
      .where(eq(importRun.id, run.id));
    this.logger.log(
      `import finalized: ${counts.documents} documents, ${counts.facts} facts, ` +
        `${counts.contradictions} contradictions, ${counts.superseded} superseded`,
    );
  }

  private async cleanupStaging(runId: string): Promise<void> {
    const staged = await this.db
      .select()
      .from(importItem)
      .where(and(eq(importItem.runId, runId), sql`${importItem.stagingKey} IS NOT NULL`));
    for (const item of staged) {
      await this.objects.deleteObject(item.stagingKey!).catch(() => undefined);
      await this.setItem(item.id, { stagingKey: null });
    }
  }

  private async itemsIn(runId: string, states: ImportItemRow['state'][]): Promise<ImportItemRow[]> {
    return this.db
      .select()
      .from(importItem)
      .where(and(eq(importItem.runId, runId), inArray(importItem.state, states)))
      .orderBy(importItem.name, importItem.id);
  }

  private async setItem(
    itemId: string,
    patch: Partial<typeof importItem.$inferInsert>,
  ): Promise<void> {
    await this.db
      .update(importItem)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(importItem.id, itemId));
  }

  private async setPaused(run: ImportRunRow, reason: string | null): Promise<void> {
    const current = run.optionsJson?.pausedReason ?? null;
    if (current === reason) return;
    await this.db
      .update(importRun)
      .set({ optionsJson: { ...(run.optionsJson ?? {}), pausedReason: reason } })
      .where(eq(importRun.id, run.id));
  }
}

/** The run owner as a Principal for the gated reads and the upload path.
 * The org id comes from any staged/final key's first segment. Carries the
 * RUN's space (docs/features/spaces.md): a worker acting on a row acts in
 * that row's space, so every document this run feeds through the one upload
 * path is stamped into it. */
function principalFor(run: ImportRunRow): Principal {
  return {
    userId: run.ownerId,
    name: '',
    email: null,
    orgId: run.orgId,
    orgName: '',
    roles: [],
    spaceId: run.spaceId,
  };
}
