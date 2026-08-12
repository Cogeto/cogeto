import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import { DRIZZLE, enqueueDelayedJob, runSingleFlight } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { FilesService } from '../files/index';
import { SourceRevisionStore } from '../ingestion/index';
import { ConnectorCredentialOpener, ConnectorCredentialStore } from '../identity/index';
import type {
  ConnectorSecrets,
  ConnectorDescriptor,
  UpstreamItem,
  UpstreamItemContent,
} from './connector-descriptor';
import { UpstreamAuthError, UpstreamRateLimitError } from './connector-descriptor';
import { ConnectorRegistry } from './connector-registry';
import {
  AUTHORED_DAILY_ITEM_CAP,
  BACKFILL_DEFAULT_DAYS,
  BACKFILL_DEFAULT_ITEM_CAP,
  OBSERVED_DAILY_ITEM_CAP,
} from './connectors.options';
import { ProjectService } from '../projects/index';
import { CONNECTOR_PIPELINE_PRIORITY, CONNECTOR_SYNC_JOB_TYPE } from './connector-jobs';
import { ConnectorStore } from './persistence/connector-store';
import { ConnectorItemLedger, contentHashOf } from './persistence/item-ledger';
import { SYNCABLE_STATES } from './domain/lifecycle';
import {
  acquire,
  DEFAULT_RATE_PROFILE,
  freshBucket,
  recordRetryAfter,
} from './domain/token-bucket';
import { emptyCounts } from './persistence/tables';
import type { ConnectorRow, ConnectorSubScopeRow, SyncRunCounts } from './persistence/tables';

/** Items asked of the upstream per page. */
const PAGE_SIZE = 50;
/** Pages one pass processes before re-enqueueing itself: keeps a pass short
 * so the single-flight lock never pins a worker slot for long. */
const PAGES_PER_PASS = 5;
/** Seconds between passes while work remains. */
const ADVANCE_INTERVAL_SECONDS = 6;
/** Minutes between passes while paused on a cap or budget. */
const CAP_PAUSE_MINUTES = 30;
/** Refresh a credential when its expiry is within this window. */
const REFRESH_WINDOW_MS = 10 * 60 * 1000;

/**
 * The sync engine (V2.5 item 8.1, issues C and E): a plain, re-runnable
 * `connector.sync` pass under a per-connector single-flight lock, the
 * `import.advance` shape. All state is rows: the cursor persists after every
 * page, the natural-key ledger absorbs anything re-listed, so an interrupted
 * sync resumes at the cost of at most one page of LISTING work and zero
 * extraction work. Materialization enters the ONE existing upload path at
 * demoted priority; the gate, the budgets and the per-user daily caps apply
 * exactly as for a single upload, and exhaustion pauses visibly.
 */
@Injectable()
export class ConnectorSyncEngine {
  private readonly logger = new Logger(ConnectorSyncEngine.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: ConnectorRegistry,
    private readonly store: ConnectorStore,
    private readonly ledger: ConnectorItemLedger,
    private readonly credentials: ConnectorCredentialStore,
    private readonly revisions: SourceRevisionStore,
    /** Worker-only collaborators: the credential opener exists only in roots
     * registered with credentialReads, and materialization needs the files
     * module. Their absence makes a pass refuse loudly, not silently skip. */
    @Optional() private readonly opener?: ConnectorCredentialOpener,
    @Optional() private readonly files?: FilesService,
    /** Projects (V2.5 item 8.3): a sub-scope assigned to a project stamps
     * its project on every source it materializes, inside the SAME upload
     * transaction, so there is no window in which the source has no project
     * and no repair pass to run. Absent → nothing is ever stamped, which is
     * the pre-feature path. */
    @Optional() private readonly projects?: ProjectService,
  ) {}

  async advance(connectorId: string): Promise<{ advanced: boolean }> {
    const outcome = await runSingleFlight(this.db, `connector:${connectorId}`, async () => {
      await this.pass(connectorId);
    });
    return { advanced: outcome.ran };
  }

  private async pass(connectorId: string): Promise<void> {
    const row = await this.store.byId(connectorId);
    if (!row || !SYNCABLE_STATES.includes(row.state)) return;

    // The Retry-After wall gates the WHOLE pass, discovery included: a pass
    // inside the wall touches the upstream zero times and reschedules
    // itself beyond it (issue E1: never retry into the same wall).
    const wall = await this.store.rateState(connectorId, 'connector');
    if (wall?.retryAfterUntil && wall.retryAfterUntil.getTime() > Date.now()) {
      const waitSeconds = (wall.retryAfterUntil.getTime() - Date.now()) / 1000;
      await this.setPaused(row, 'rate_limited');
      await this.reschedule(connectorId, row.ownerId, Math.max(waitSeconds / 60, 0.1));
      return;
    }

    const descriptor = this.registry.get(row.kind);
    if (!descriptor) {
      // A connector whose kind is no longer registered cannot sync; say so.
      await this.store.transition(this.db, row, 'degraded', {
        actor: 'connector_platform',
        reason: 'kind_not_registered',
      });
      return;
    }

    // Credentials: open, refresh ahead of expiry, and never let an expired
    // credential look like "the source had nothing new" (issue B2).
    let secrets: ConnectorSecrets = null;
    if (descriptor.auth !== 'none') {
      if (!this.opener) throw new Error('connector sync requires the credential opener (worker)');
      const opened = await this.opener.open(connectorId);
      if (!opened) {
        await this.store.transition(this.db, row, 'needs_reauth', {
          actor: 'connector_platform',
          reason: 'credential_missing',
        });
        return;
      }
      secrets = opened.material;
      const expiringSoon =
        opened.expiresAt !== null && opened.expiresAt.getTime() - Date.now() < REFRESH_WINDOW_MS;
      if (expiringSoon && descriptor.refresh) {
        try {
          const rotated = await descriptor.refresh(secrets);
          await this.credentials.recordRefresh(
            this.db,
            connectorId,
            rotated.material,
            rotated.expiresAt,
          );
          secrets = rotated.material;
        } catch {
          await this.credentials.recordRefreshFailure(this.db, connectorId);
          await this.store.transition(this.db, row, 'needs_reauth', {
            actor: 'connector_platform',
            reason: 'refresh_failed',
          });
          return;
        }
      }
    }

    // Discovery refresh: what exists upstream, offered for selection. The
    // selection itself is the user's; nothing outside it is ever fetched.
    if (descriptor.hasSubScopes) {
      try {
        const discovered = await descriptor.listSubScopes!(secrets);
        await this.store.recordDiscoveredSubScopes(connectorId, row.ownerId, discovered);
      } catch (error) {
        if (error instanceof UpstreamRateLimitError) {
          await this.recordUpstreamWall(connectorId, error.retryAfterSeconds);
          await this.setPaused(row, 'rate_limited');
          await this.reschedule(connectorId, row.ownerId, error.retryAfterSeconds / 60);
          return;
        }
        await this.classifyUpstreamFailure(row, error, null);
        return;
      }
    } else {
      await this.store.ensureImplicitScope(connectorId, row.ownerId);
    }

    const scopes = await this.store.selectedSubScopes(connectorId);
    if (scopes.length === 0) return; // discovery-only: nothing selected yet

    const kind = scopes.some((s) => !(s.backfillJson?.complete ?? false))
      ? ('backfill' as const)
      : ('incremental' as const);
    const run = await this.store.openSyncRun(connectorId, row.ownerId, kind);
    const counts: SyncRunCounts = (run.countsJson as SyncRunCounts) ?? emptyCounts();
    if (row.state !== 'syncing') {
      await this.store.transition(this.db, row, 'syncing', { actor: 'connector_platform' });
    }
    // A pass that reaches its scopes is no longer waiting on whatever paused
    // the previous one; a pause that still holds re-declares itself below.
    await this.setPaused(row, null);

    let pagesLeft = PAGES_PER_PASS;
    let allFinished = true;
    for (const scope of scopes) {
      if (pagesLeft <= 0) {
        allFinished = false;
        break;
      }
      const outcome = await this.syncScope(row, descriptor, secrets, scope, counts, pagesLeft);
      pagesLeft -= outcome.pagesUsed;
      if (!outcome.finished) allFinished = false;
      await this.store.recordRunCounts(run.id, counts);
      if (outcome.stop === 'pause') {
        await this.setPaused(row, outcome.pauseReason!);
        await this.reschedule(connectorId, row.ownerId, outcome.delayMinutes!);
        return;
      }
      if (outcome.stop === 'fail') {
        await this.store.closeSyncRun(run.id, 'failed', 'sync_failed');
        return; // transition already recorded
      }
    }

    // The page budget ran out with listing work remaining (backfill OR
    // incremental): the pass hands the lock back and re-enqueues itself, the
    // import.advance shape. The run stays open and the cursor already
    // persisted per page, so a crash here costs nothing.
    if (!allFinished) {
      await this.reschedule(connectorId, row.ownerId, ADVANCE_INTERVAL_SECONDS / 60);
      return;
    }

    await this.setPaused(row, null);
    await this.store.recordRunCounts(run.id, counts);
    await this.store.closeSyncRun(run.id, 'completed');
    await this.store.recordSyncFinished(connectorId);
    const fresh = await this.store.byId(connectorId);
    if (fresh && fresh.state === 'syncing') {
      await this.store.transition(this.db, fresh, 'healthy', { actor: 'connector_platform' });
    }
  }

  /** One sub-scope's slice of the pass. */
  private async syncScope(
    row: ConnectorRow,
    descriptor: ConnectorDescriptor,
    secrets: ConnectorSecrets,
    scope: ConnectorSubScopeRow,
    counts: SyncRunCounts,
    pageBudget: number,
  ): Promise<{
    pagesUsed: number;
    /** True when this scope's listing completed inside the pass. */
    finished: boolean;
    stop?: 'pause' | 'fail';
    pauseReason?: string;
    delayMinutes?: number;
  }> {
    const settings = row.settingsJson ?? {};
    const backfill = scope.backfillJson ?? { itemsDone: 0, complete: false };
    const inBackfill = !backfill.complete;
    const backfillAll = settings.backfillAll ?? false;
    const since =
      inBackfill && !backfillAll
        ? new Date(Date.now() - (settings.backfillDays ?? BACKFILL_DEFAULT_DAYS) * 86_400_000)
        : null;
    const backfillCap = backfillAll
      ? Number.POSITIVE_INFINITY
      : (settings.backfillItemCap ?? BACKFILL_DEFAULT_ITEM_CAP);

    // The cursor advances locally within the pass and durably after every
    // processed page; the row object was loaded at pass start and must not
    // serve a second page.
    let cursor: unknown = scope.cursorJson ?? null;
    let pagesUsed = 0;
    while (pagesUsed < pageBudget) {
      // Outbound rate limiting (issue E1): the bucket and any Retry-After
      // wall, both durable. Denial reschedules; it never spins.
      const wait = await this.acquireRateToken(row.id, descriptor);
      if (wait > 0) {
        return {
          pagesUsed,
          finished: false,
          stop: 'pause',
          pauseReason: 'rate_limited',
          delayMinutes: Math.max(wait / 60, 0.1),
        };
      }

      let page;
      try {
        page = await descriptor.fetchPage(secrets, {
          subScope: scope.key === '' ? null : scope.key,
          cursor,
          limit: PAGE_SIZE,
          since,
          scopeSettings: scope.settingsJson ?? null,
        });
      } catch (error) {
        if (error instanceof UpstreamRateLimitError) {
          await this.recordUpstreamWall(row.id, error.retryAfterSeconds);
          return {
            pagesUsed,
            finished: false,
            stop: 'pause',
            pauseReason: 'rate_limited',
            delayMinutes: Math.max(error.retryAfterSeconds / 60, 0.1),
          };
        }
        await this.classifyUpstreamFailure(row, error, null);
        return { pagesUsed, finished: false, stop: 'fail' };
      }
      pagesUsed += 1;
      counts.pages += 1;

      for (const item of page.items) {
        counts.fetched += 1;
        const paused = await this.processItem(row, descriptor, scope, item, counts, backfill);
        if (paused) {
          // Cap, budget or rate wall hit mid-page: the cursor does NOT
          // advance past this page, so the remainder is re-listed next pass
          // and the ledger skips what already landed.
          await this.store.recordBackfill(row.id, scope.key, backfill);
          return {
            pagesUsed,
            finished: false,
            stop: 'pause',
            pauseReason: paused.pause,
            delayMinutes: paused.delayMinutes,
          };
        }
      }

      // The page is fully processed: NOW the cursor persists (issue C1).
      cursor = page.cursor;
      await this.store.recordCursor(row.id, scope.key, page.cursor);
      if (inBackfill) {
        backfill.complete = page.done || backfill.itemsDone >= backfillCap;
        await this.store.recordBackfill(row.id, scope.key, backfill);
        if (backfill.complete) return { pagesUsed, finished: true };
      } else if (page.done) {
        return { pagesUsed, finished: true };
      }
    }
    // The page budget ran out with this scope's listing incomplete.
    return { pagesUsed, finished: false };
  }

  /**
   * One item through the encoded decision table (issue C2). Returns a pause
   * when an admission bound or a rate wall stops the pass, null otherwise.
   * Also the webhook processor's entry, so both paths converge on identical
   * rules.
   */
  async processItem(
    row: ConnectorRow,
    descriptor: ConnectorDescriptor,
    scope: ConnectorSubScopeRow | null,
    item: UpstreamItem,
    counts: SyncRunCounts,
    backfill?: { itemsDone: number; complete: boolean },
  ): Promise<{ pause: string; delayMinutes: number } | null> {
    // spec 4.4.4: an item restricted to a subset of users is skipped and
    // reported, never guessed at.
    if (item.visibility === 'restricted') {
      counts.skippedRestricted += 1;
      return null;
    }
    const subScopeKey = scope ? (scope.key === '' ? null : scope.key) : (item.subScope ?? null);
    // Lazy content exists precisely so the skip decision runs before any
    // bytes do; a lazy item without an upstream change marker would defeat
    // that, so it is a descriptor defect and refuses loudly.
    if (typeof item.content === 'function' && !item.contentHash) {
      throw new Error(`connector '${descriptor.kind}' returned lazy content without a contentHash`);
    }
    const hash = item.contentHash ?? contentHashOf((item.content as UpstreamItemContent).bytes);
    const decision = await this.ledger.decide(row.id, item.naturalKey, hash, subScopeKey);

    if (item.deleted) {
      // An upstream deletion is a fact about the upstream, not an
      // instruction to erase verified memory: the source remains.
      if (decision.action !== 'new' && decision.action !== 'erased_stays_erased') {
        await this.ledger.markDeletedUpstream(decision.item.id);
        counts.deletedUpstream += 1;
      }
      return null;
    }

    switch (decision.action) {
      case 'erased_stays_erased':
        counts.erasedSkipped += 1;
        return null;
      case 'unchanged':
        counts.unchangedSkipped += 1;
        await this.ledger.touchSeen(decision.item.id, subScopeKey);
        return null;
      case 'moved': {
        counts.moved += 1;
        const impliedScope = item.visibility === 'team' ? 'shared' : 'private';
        if (decision.item.materializedScope && decision.item.materializedScope !== impliedScope) {
          // Consequential: reported for the user, never silently re-stamped.
          counts.scopeChangesReported += 1;
        }
        await this.ledger.touchSeen(decision.item.id, subScopeKey);
        return null;
      }
      case 'new': {
        const capPause = await this.admissionPause(row, descriptor, scope);
        if (capPause) return { pause: capPause, delayMinutes: CAP_PAUSE_MINUTES };
        const outcome = await this.materialize(row, descriptor, item, counts, subScopeKey);
        if (outcome.kind === 'pause') return outcome.pauseResult;
        if (outcome.kind !== 'ok') return null;
        const source = outcome.source;
        await this.ledger.recordNew({
          connectorId: row.id,
          ownerId: row.ownerId,
          naturalKey: item.naturalKey,
          contentHash: hash,
          subScope: subScopeKey,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          materializedScope: item.visibility === 'team' ? 'shared' : 'private',
        });
        await this.annotate(row, descriptor, item, source);
        counts.materialized += 1;
        if (backfill) backfill.itemsDone += 1;
        return null;
      }
      case 'changed': {
        // Upstream edit: a new source as a revision that supersedes, never a
        // duplicate that contradicts itself. The upstream's own "same item,
        // new content" is stronger evidence than a filename match, so the
        // link is automatic (docs/features/revisions.md inherits this).
        const capPause = await this.admissionPause(row, descriptor, scope);
        if (capPause) return { pause: capPause, delayMinutes: CAP_PAUSE_MINUTES };
        const predecessor = {
          sourceType: decision.item.sourceType,
          sourceId: decision.item.sourceId,
        };
        const outcome = await this.materialize(row, descriptor, item, counts, subScopeKey);
        if (outcome.kind === 'pause') return outcome.pauseResult;
        if (outcome.kind !== 'ok') return null;
        const source = outcome.source;
        await this.ledger.recordChanged(decision.item.id, {
          contentHash: hash,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
        });
        if (predecessor.sourceType && predecessor.sourceId) {
          await this.revisions
            .recordDetected(this.db, {
              ownerId: row.ownerId,
              successor: source,
              predecessor: {
                sourceType: predecessor.sourceType,
                sourceId: predecessor.sourceId,
              },
              status: 'auto',
              basis: {
                filename: outcome.filename,
                // The upstream's own revision marker, so a finding resolved
                // by this edit can name the version that resolved it.
                revisionNew: item.upstreamRevision ?? null,
                revisionOld: null,
                subjectOverlap: null,
                classMatch: null,
                shingleSimilarity: null,
                confidence: 'high',
                upstreamIdentity: item.naturalKey,
              },
            })
            .catch((error: Error) => {
              // Linking is metadata: a failure never fails the sync.
              this.logger.warn(`revision link failed for one item: ${error.message}`);
            });
        }
        await this.annotate(row, descriptor, item, source);
        counts.revisions += 1;
        if (backfill) backfill.itemsDone += 1;
        return null;
      }
    }
  }

  /**
   * The project a sub-scope is assigned to (V2.5 item 8.3), by KEY, so the
   * poll and the webhook path resolve it identically. One keyed read per
   * materialized item, which is the one point past which an item already
   * costs an upload and a pipeline run. Never fails a sync: an unresolvable
   * project means the source lands unassigned, exactly as before projects
   * existed.
   */
  private async projectForSubScope(
    row: ConnectorRow,
    subScopeKey: string | null,
  ): Promise<string | undefined> {
    if (!this.projects || !subScopeKey) return undefined;
    try {
      const scope = await this.store.subScopeByKey(row.id, subScopeKey);
      if (!scope) return undefined;
      const found = await this.projects.projectIdsForRefs(row.ownerId, 'connector_sub_scope', [
        scope.id,
      ]);
      return found.get(scope.id);
    } catch {
      return undefined;
    }
  }

  /** Connector-owned provenance for a materialized source; metadata, so a
   * failure is logged and never fails the sync. */
  private async annotate(
    row: ConnectorRow,
    descriptor: ConnectorDescriptor,
    item: UpstreamItem,
    source: { sourceType: string; sourceId: string },
  ): Promise<void> {
    if (!descriptor.annotate) return;
    try {
      await descriptor.annotate(this.db, item, source, {
        id: row.id,
        ownerId: row.ownerId,
        orgId: row.orgId,
      });
    } catch (error) {
      this.logger.warn(`connector annotate failed for one item: ${(error as Error).message}`);
    }
  }

  /** The per-authorship admission bound (issue E2): observed 200, authored
   * 1000 per day, configurable per connector and per sub-scope. */
  private async admissionPause(
    row: ConnectorRow,
    descriptor: ConnectorDescriptor,
    scope: ConnectorSubScopeRow | null,
  ): Promise<string | null> {
    const classDefault =
      descriptor.authorship === 'observed' ? OBSERVED_DAILY_ITEM_CAP : AUTHORED_DAILY_ITEM_CAP;
    const connectorCap = row.settingsJson?.dailyItemCap ?? classDefault;
    if ((await this.ledger.materializedToday(row.id)) >= connectorCap) {
      return 'daily_item_cap';
    }
    if (scope && scope.itemCap !== null && scope.key !== '') {
      if ((await this.ledger.materializedTodayInScope(row.id, scope.key)) >= scope.itemCap) {
        return 'daily_item_cap';
      }
    }
    return null;
  }

  /**
   * Materialization through the ONE existing upload path at demoted
   * priority: the extraction gate, the budgets and the per-user daily caps
   * apply exactly as for a single upload. Lazy content resolves HERE, and
   * only here, behind the same token bucket as a listing call: this is the
   * point past which an item costs something, and everything before it is
   * free by construction (the zero-cost re-sync property).
   */
  private async materialize(
    row: ConnectorRow,
    descriptor: ConnectorDescriptor,
    item: UpstreamItem,
    counts: SyncRunCounts,
    subScopeKey: string | null,
  ): Promise<
    | { kind: 'ok'; source: { sourceType: string; sourceId: string }; filename: string }
    | { kind: 'pause'; pauseResult: { pause: string; delayMinutes: number } }
    | { kind: 'skipped' }
    | { kind: 'failed' }
  > {
    if (!this.files) throw new Error('connector sync requires the files module (worker)');
    let content: UpstreamItemContent;
    if (typeof item.content === 'function') {
      const wait = await this.acquireRateToken(row.id, descriptor);
      if (wait > 0) {
        return {
          kind: 'pause',
          pauseResult: { pause: 'rate_limited', delayMinutes: Math.max(wait / 60, 0.1) },
        };
      }
      let resolved;
      try {
        resolved = await item.content();
      } catch (error) {
        if (error instanceof UpstreamRateLimitError) {
          await this.recordUpstreamWall(row.id, error.retryAfterSeconds);
          return {
            kind: 'pause',
            pauseResult: {
              pause: 'rate_limited',
              delayMinutes: Math.max(error.retryAfterSeconds / 60, 0.1),
            },
          };
        }
        if (error instanceof UpstreamAuthError) throw error;
        this.logger.warn(`connector item content fetch failed: ${(error as Error).message}`);
        counts.failed += 1;
        return { kind: 'failed' };
      }
      if (resolved === 'restricted') {
        // Visible to a subset of users after all: skipped and reported,
        // exactly as a restricted listing item is (spec 4.4.4).
        counts.skippedRestricted += 1;
        return { kind: 'skipped' };
      }
      if (resolved === null) {
        // Gone upstream between the listing and the fetch.
        counts.deletedUpstream += 1;
        return { kind: 'skipped' };
      }
      content = resolved;
    } else {
      content = item.content;
    }
    try {
      const { objectKey } = await this.files.upload(
        principalFor(row),
        {
          buffer: content.bytes,
          originalName: content.filename,
          mimeType: content.contentType,
        },
        {
          // spec 4.4.4: inherited from the source system, structurally.
          scope: item.visibility === 'team' ? 'shared' : 'private',
          sensitive: false,
          discard: false,
        },
        {
          jobPriority: CONNECTOR_PIPELINE_PRIORITY,
          // The sub-scope key, so the extraction gate's folder dimension
          // can express per-space policy (issue B3 of the first connector).
          gateFolder: subScopeKey ?? item.subScope ?? undefined,
          // A sub-scope assigned to a project puts everything it ingests
          // there (V2.5 item 8.3 issue C1). Stamped INSIDE the upload
          // transaction, so no window exists where the source has no
          // project; a later reassignment moves what the scope ingests
          // NEXT and never rewrites what it already recorded.
          projectId: await this.projectForSubScope(row, subScopeKey ?? item.subScope ?? null),
        },
      );
      return {
        kind: 'ok',
        source: { sourceType: descriptor.sourceType, sourceId: objectKey },
        filename: content.filename,
      };
    } catch (error) {
      const status = (error as { getStatus?: () => number }).getStatus?.();
      if (status === 429) {
        // Pause, never bypass.
        return {
          kind: 'pause',
          pauseResult: { pause: 'daily_upload_limit', delayMinutes: CAP_PAUSE_MINUTES },
        };
      }
      this.logger.warn(`connector item failed to materialize: ${(error as Error).message}`);
      counts.failed += 1;
      return { kind: 'failed' };
    }
  }

  /**
   * A targeted single-item fetch for the webhook processor, behind the same
   * token bucket as the poll. A denied token throws the rate-limit error so
   * the queue's backoff carries the wait.
   */
  async rateLimitedFetchItem(
    row: ConnectorRow,
    descriptor: ConnectorDescriptor,
    secrets: ConnectorSecrets,
    ref: { naturalKey: string; subScope?: string | null },
  ): Promise<UpstreamItem | null> {
    const wait = await this.acquireRateToken(row.id, descriptor);
    if (wait > 0) throw new UpstreamRateLimitError(wait);
    try {
      return await descriptor.fetchItem(secrets, ref);
    } catch (error) {
      if (error instanceof UpstreamRateLimitError) {
        await this.recordUpstreamWall(row.id, error.retryAfterSeconds);
      }
      throw error;
    }
  }

  /** A webhook deletion event for an item the ledger knows: record it; the
   * source remains. True when the item existed. */
  async markGoneUpstream(connectorId: string, naturalKey: string): Promise<boolean> {
    const item = await this.ledger.byNaturalKey(connectorId, naturalKey);
    if (!item || item.state === 'erased' || item.state === 'deleted_upstream') return false;
    await this.ledger.markDeletedUpstream(item.id);
    return true;
  }

  // ── Rate limiting (issue E1) ─────────────────────────────────────────────

  private async acquireRateToken(
    connectorId: string,
    descriptor: ConnectorDescriptor,
  ): Promise<number> {
    const profile = descriptor.rate ?? DEFAULT_RATE_PROFILE;
    const now = new Date();
    const state =
      (await this.store.rateState(connectorId, 'connector')) ?? freshBucket(profile, now);
    const result = acquire(state, profile, now);
    if (result.granted) {
      await this.store.saveRateState(connectorId, 'connector', result.state);
      return 0;
    }
    return result.waitSeconds;
  }

  private async recordUpstreamWall(connectorId: string, seconds: number): Promise<void> {
    const now = new Date();
    const state =
      (await this.store.rateState(connectorId, 'connector')) ??
      freshBucket(DEFAULT_RATE_PROFILE, now);
    await this.store.saveRateState(connectorId, 'connector', recordRetryAfter(state, now, seconds));
  }

  // ── Failure classification and rescheduling ──────────────────────────────

  /** True when the failure was terminal for this pass. */
  private async classifyUpstreamFailure(
    row: ConnectorRow,
    error: unknown,
    runId: string | null,
  ): Promise<boolean> {
    if (error instanceof UpstreamAuthError) {
      await this.store.transition(this.db, row, 'needs_reauth', {
        actor: 'connector_platform',
        reason: 'upstream_rejected_credential',
      });
      if (runId) await this.store.closeSyncRun(runId, 'failed', 'auth');
      return true;
    }
    const message = error instanceof Error ? error.message : 'upstream failure';
    this.logger.warn(`connector sync failed: ${message}`);
    await this.store.transition(this.db, row, 'degraded', {
      actor: 'connector_platform',
      reason: 'sync_failed',
    });
    if (runId) await this.store.closeSyncRun(runId, 'failed', 'sync_failed');
    return true;
  }

  private async setPaused(row: ConnectorRow, reason: string | null): Promise<void> {
    const settings = row.settingsJson ?? {};
    if ((settings.pausedReason ?? null) === reason) return;
    await this.store.updateSettings(row.id, { ...settings, pausedReason: reason });
  }

  private async reschedule(
    connectorId: string,
    ownerId: string,
    delayMinutes: number,
  ): Promise<void> {
    await enqueueDelayedJob(
      this.db,
      {
        type: CONNECTOR_SYNC_JOB_TYPE,
        // enqueueDelayedJob passes the payload verbatim, so the attribution
        // key is stamped here directly (SEC-10; JOB_PRINCIPAL_KEY).
        payload: { source_type: 'connector', source_id: connectorId, principal_id: ownerId },
      },
      delayMinutes,
    );
  }
}

/** The owner as a Principal for the upload path (the import precedent). */
function principalFor(row: ConnectorRow): Principal {
  return {
    userId: row.ownerId,
    name: '',
    email: null,
    orgId: row.orgId,
    orgName: '',
    roles: [],
  };
}
