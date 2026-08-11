import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DRIZZLE, runSingleFlight } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { ConnectorCredentialOpener } from '../identity/index';
import type { ConnectorSecrets } from './connector-descriptor';
import { UpstreamAuthError, UpstreamRateLimitError } from './connector-descriptor';
import { ConnectorRegistry } from './connector-registry';
import { ConnectorStore } from './persistence/connector-store';
import { ConnectorItemLedger } from './persistence/item-ledger';
import { SYNCABLE_STATES } from './domain/lifecycle';
import { emptyCounts } from './persistence/tables';
import type { SyncRunCounts } from './persistence/tables';

/** Identifiers asked of the upstream per presence page. */
const PRESENCE_PAGE_SIZE = 250;
/** Backstop against a runaway upstream listing; identifiers only, so this
 * bounds memory, not model spend. */
const PRESENCE_MAX_KEYS = 100_000;

/**
 * The presence sweep (V2.5 item 8.2, issue C5): incremental discovery by
 * modified date structurally cannot observe an absence, so this pass pages
 * through the natural keys the upstream STILL lists (identifiers only,
 * `listKeys`), per selected sub-scope, and reconciles the ledger: an item no
 * longer listed is marked gone with the observed reason (`absent`, or
 * `archived` where the upstream can say), a reappeared item is restored, and
 * nothing is ever deleted, because deletion is the user's act. Runs under
 * the same per-connector single-flight lock as the sync, so the two never
 * interleave on the ledger.
 */
@Injectable()
export class ConnectorPresenceSweep {
  private readonly logger = new Logger(ConnectorPresenceSweep.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: ConnectorRegistry,
    private readonly store: ConnectorStore,
    private readonly ledger: ConnectorItemLedger,
    @Optional() private readonly opener?: ConnectorCredentialOpener,
  ) {}

  async sweep(connectorId: string): Promise<{ swept: boolean }> {
    const outcome = await runSingleFlight(this.db, `connector:${connectorId}`, async () => {
      await this.pass(connectorId);
    });
    return { swept: outcome.ran };
  }

  private async pass(connectorId: string): Promise<void> {
    const row = await this.store.byId(connectorId);
    if (!row || !SYNCABLE_STATES.includes(row.state)) return;
    const descriptor = this.registry.get(row.kind);
    if (!descriptor?.listKeys) return;

    // The Retry-After wall gates the sweep exactly as it gates a sync pass.
    const wall = await this.store.rateState(connectorId, 'connector');
    if (wall?.retryAfterUntil && wall.retryAfterUntil.getTime() > Date.now()) return;

    let secrets: ConnectorSecrets = null;
    if (descriptor.auth !== 'none') {
      if (!this.opener) throw new Error('presence sweep requires the credential opener (worker)');
      const opened = await this.opener.open(connectorId);
      if (!opened) return;
      secrets = opened.material;
    }

    const scopes = await this.store.selectedSubScopes(connectorId);
    if (scopes.length === 0) return;

    const run = await this.store.openSyncRun(connectorId, row.ownerId, 'presence');
    const counts: SyncRunCounts = (run.countsJson as SyncRunCounts) ?? emptyCounts();
    try {
      for (const scope of scopes) {
        const scopeKey = scope.key === '' ? null : scope.key;
        const observed = new Map<string, 'present' | 'archived'>();
        let cursor: unknown = null;
        // A partially observed set must never mark absences: only a scope
        // listed to completion reconciles.
        for (;;) {
          const page = await descriptor.listKeys(secrets, {
            subScope: scopeKey,
            cursor,
            limit: PRESENCE_PAGE_SIZE,
          });
          for (const key of page.keys) {
            observed.set(key.naturalKey, key.state ?? 'present');
          }
          if (observed.size > PRESENCE_MAX_KEYS) {
            this.logger.warn('presence sweep aborted: upstream lists too many keys');
            await this.store.closeSyncRun(run.id, 'failed', 'presence_overflow');
            return;
          }
          cursor = page.cursor;
          if (page.done) break;
        }
        const { markedGone, restored } = await this.ledger.reconcilePresence(
          connectorId,
          scopeKey,
          observed,
        );
        counts.presenceMarkedGone = (counts.presenceMarkedGone ?? 0) + markedGone;
        counts.presenceRestored = (counts.presenceRestored ?? 0) + restored;
        counts.deletedUpstream += markedGone;
        await this.store.recordRunCounts(run.id, counts);
      }
      await this.store.closeSyncRun(run.id, 'completed');
      await this.store.recordPresenceSwept(connectorId);
    } catch (error) {
      if (error instanceof UpstreamAuthError) {
        await this.store.transition(this.db, row, 'needs_reauth', {
          actor: 'connector_platform',
          reason: 'upstream_rejected_credential',
        });
        await this.store.closeSyncRun(run.id, 'failed', 'auth');
        return;
      }
      if (error instanceof UpstreamRateLimitError) {
        // The next maintenance pass retries beyond the wall; nothing was
        // marked from a partial listing.
        await this.store.closeSyncRun(run.id, 'failed', 'rate_limited');
        return;
      }
      this.logger.warn(`presence sweep failed: ${(error as Error).message}`);
      await this.store.closeSyncRun(run.id, 'failed', 'sweep_failed');
    }
  }
}
