import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { ConnectorCredentialOpener } from '../identity/index';
import type { ConnectorSecrets } from './connector-descriptor';
import { UpstreamAuthError, UpstreamRateLimitError } from './connector-descriptor';
import { ConnectorRegistry } from './connector-registry';
import { ConnectorStore } from './persistence/connector-store';
import { ConnectorSyncEngine } from './sync-engine';
import { SYNCABLE_STATES } from './domain/lifecycle';
import { emptyCounts } from './persistence/tables';
import type { SyncRunCounts } from './persistence/tables';

/**
 * The webhook delivery processor (V2.5 item 8.1, issue D): the worker half
 * of the ingress. The payload was only a signal, so processing is a TARGETED
 * FETCH of the named items from the upstream through the normal outbound
 * path, converging on the same dedup decision table the poll uses. That is
 * also what makes ordering a non-issue: a delivery processed late or twice
 * fetches current upstream state and lands on the same result.
 *
 * Runs under the idempotent job wrapper keyed
 * (connector_webhook, delivery id, connector.webhook_process), so a
 * duplicate queue delivery is dropped before this code runs.
 */
@Injectable()
export class ConnectorWebhookProcessor {
  private readonly logger = new Logger(ConnectorWebhookProcessor.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly store: ConnectorStore,
    private readonly registry: ConnectorRegistry,
    private readonly engine: ConnectorSyncEngine,
    @Optional() private readonly opener?: ConnectorCredentialOpener,
  ) {}

  async process(deliveryId: string): Promise<void> {
    const delivery = await this.store.delivery(deliveryId);
    if (!delivery || delivery.state === 'processed') return;
    const connector = await this.store.byId(delivery.connectorId);
    if (!connector || !SYNCABLE_STATES.includes(connector.state)) {
      await this.store.markDelivery(deliveryId, 'failed');
      return;
    }
    const descriptor = this.registry.get(connector.kind);
    if (!descriptor) {
      await this.store.markDelivery(deliveryId, 'failed');
      return;
    }

    let secrets: ConnectorSecrets = null;
    if (descriptor.auth !== 'none') {
      if (!this.opener) throw new Error('webhook processing requires the credential opener');
      const opened = await this.opener.open(connector.id);
      if (!opened) {
        await this.store.markDelivery(deliveryId, 'failed');
        return;
      }
      secrets = opened.material;
    }

    const run = await this.store.openSyncRun(connector.id, connector.ownerId, 'webhook');
    const counts: SyncRunCounts = (run.countsJson as SyncRunCounts) ?? emptyCounts();

    try {
      for (const ref of delivery.itemRefJson ?? []) {
        const item = await this.engine.rateLimitedFetchItem(connector, descriptor, secrets, ref);
        if (item === null) {
          // Gone upstream between the event and the fetch: record the
          // upstream deletion if the ledger knows the item; sources remain.
          const known = await this.engine.markGoneUpstream(connector.id, ref.naturalKey);
          if (known) counts.deletedUpstream += 1;
          continue;
        }
        counts.fetched += 1;
        await this.engine.processItem(connector, descriptor, null, item, counts);
      }
      await this.store.recordRunCounts(run.id, counts);
      await this.store.closeSyncRun(run.id, 'completed');
      await this.store.markDelivery(deliveryId, 'processed');
    } catch (error) {
      if (error instanceof UpstreamAuthError) {
        await this.store.transition(this.db, connector, 'needs_reauth', {
          actor: 'connector_platform',
          reason: 'upstream_rejected_credential',
        });
        await this.store.closeSyncRun(run.id, 'failed', 'auth');
        await this.store.markDelivery(deliveryId, 'failed');
        return;
      }
      if (error instanceof UpstreamRateLimitError) {
        // Let the queue's backoff retry the delivery beyond the wall.
        await this.store.closeSyncRun(run.id, 'failed', 'rate_limited');
        throw error;
      }
      this.logger.warn(`webhook processing failed: ${(error as Error).message}`);
      await this.store.closeSyncRun(run.id, 'failed', 'processing_failed');
      await this.store.markDelivery(deliveryId, 'failed');
    }
  }
}
