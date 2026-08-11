import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DRIZZLE, enqueueDelayedJob } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { ConnectorCredentialOpener, ConnectorCredentialStore } from '../identity/index';
import { ConnectorRegistry } from './connector-registry';
import { ConnectorStore } from './persistence/connector-store';
import {
  CONNECTOR_PRESENCE_JOB_TYPE,
  CONNECTOR_SYNC_JOB_TYPE,
  PRESENCE_SWEEP_DEFAULT_DAYS,
  WEBHOOK_DELIVERY_RETENTION_DAYS,
} from './connector-jobs';
import { SYNCABLE_STATES } from './domain/lifecycle';

/** Refresh credentials expiring within this window. */
const CREDENTIAL_REFRESH_WINDOW_MS = 30 * 60 * 1000;
/** Renew webhook subscriptions expiring within this window. */
const SUBSCRIPTION_RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The recurring maintenance pass (V2.5 item 8.1): the credential refresh
 * loop as a first-class citizen (issue B2), webhook subscription renewal
 * with the degrade-to-polling fallback (issue D4), the delivery-ledger
 * prune, and the periodic incremental sync enqueue, which IS the polling
 * fallback: a connector whose subscription lapsed keeps syncing on this
 * cadence, degraded and saying so, never silently stopped.
 *
 * Idempotent by construction (the recurring-pass contract): every step
 * re-derives its work from rows and converges.
 */
@Injectable()
export class ConnectorMaintenance {
  private readonly logger = new Logger(ConnectorMaintenance.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly store: ConnectorStore,
    private readonly registry: ConnectorRegistry,
    private readonly credentials: ConnectorCredentialStore,
    @Optional() private readonly opener?: ConnectorCredentialOpener,
  ) {}

  async run(): Promise<void> {
    await this.refreshExpiringCredentials();
    await this.renewExpiringSubscriptions();
    const pruned = await this.store.pruneDeliveriesOlderThan(WEBHOOK_DELIVERY_RETENTION_DAYS);
    if (pruned > 0) this.logger.log(`pruned ${pruned} webhook delivery rows`);
    await this.enqueueDueSyncs();
    await this.enqueueDuePresenceSweeps();
  }

  /** The presence cadence (V2.5 item 8.2, issue C5): connectors whose
   * descriptor can list current keys get a periodic reconcile, because
   * polling by modified date cannot observe an absence. */
  private async enqueueDuePresenceSweeps(): Promise<void> {
    for (const connector of await this.store.listInStates([...SYNCABLE_STATES])) {
      const descriptor = this.registry.get(connector.kind);
      if (!descriptor?.listKeys) continue;
      const cadenceDays = descriptor.presenceSweepDays ?? PRESENCE_SWEEP_DEFAULT_DAYS;
      const due =
        !connector.presenceSweptAt ||
        Date.now() - connector.presenceSweptAt.getTime() > cadenceDays * 86_400_000;
      if (!due) continue;
      await enqueueDelayedJob(
        this.db,
        {
          type: CONNECTOR_PRESENCE_JOB_TYPE,
          payload: {
            source_type: 'connector',
            source_id: connector.id,
            principal_id: connector.ownerId,
          },
        },
        0,
      );
    }
  }

  /** Refresh before expiry; failure moves to needs_reauth, never a retry
   * loop, and never a silent empty sync (issue B2). */
  private async refreshExpiringCredentials(): Promise<void> {
    if (!this.opener) return;
    const deadline = new Date(Date.now() + CREDENTIAL_REFRESH_WINDOW_MS);
    for (const summary of await this.credentials.expiringBefore(deadline)) {
      if (summary.refreshFailedAt) continue; // already parked in needs_reauth
      const connector = await this.store.byId(summary.connectorId);
      if (!connector || !SYNCABLE_STATES.includes(connector.state)) continue;
      const descriptor = this.registry.get(connector.kind);
      if (!descriptor?.refresh) continue;
      try {
        const opened = await this.opener.open(summary.connectorId);
        if (!opened) continue;
        const rotated = await descriptor.refresh(opened.material);
        await this.credentials.recordRefresh(
          this.db,
          summary.connectorId,
          rotated.material,
          rotated.expiresAt,
        );
      } catch {
        await this.credentials.recordRefreshFailure(this.db, summary.connectorId);
        await this.store.transition(this.db, connector, 'needs_reauth', {
          actor: 'connector_platform',
          reason: 'refresh_failed',
        });
      }
    }
  }

  /** Renew ahead of expiry; a failed renewal degrades to polling with the
   * state visible in capabilities (issue D4). */
  private async renewExpiringSubscriptions(): Promise<void> {
    const candidates = await this.store.listInStates([...SYNCABLE_STATES]);
    const deadline = Date.now() + SUBSCRIPTION_RENEW_WINDOW_MS;
    for (const connector of candidates) {
      if (!connector.webhookExpiresAt) continue;
      if (connector.webhookExpiresAt.getTime() > deadline) continue;
      const descriptor = this.registry.get(connector.kind);
      if (!descriptor?.webhook?.renew) continue;
      try {
        let secrets = null;
        if (descriptor.auth !== 'none') {
          if (!this.opener) continue;
          const opened = await this.opener.open(connector.id);
          if (!opened) continue;
          secrets = opened.material;
        }
        const renewedUntil = await descriptor.webhook.renew(secrets);
        await this.store.recordWebhookExpiry(connector.id, renewedUntil);
        if (connector.state === 'degraded' && connector.statusReason === 'webhook_lapsed') {
          await this.store.transition(this.db, connector, 'healthy', {
            actor: 'connector_platform',
          });
        }
      } catch (error) {
        this.logger.warn(
          `webhook renewal failed for connector ${connector.id}: ${(error as Error).message}`,
        );
        if (connector.webhookExpiresAt.getTime() <= Date.now()) {
          // Lapsed: polling (the enqueue below) carries the connector from
          // here; the degraded state names why.
          await this.store.transition(this.db, connector, 'degraded', {
            actor: 'connector_platform',
            reason: 'webhook_lapsed',
          });
        }
      }
    }
  }

  /** The polling cadence: every active connector gets an incremental pass.
   * The sync job is plain and single-flighted, so a pass already running
   * simply wins the lock and this enqueue converges to a no-op. */
  private async enqueueDueSyncs(): Promise<void> {
    for (const connector of await this.store.listInStates([...SYNCABLE_STATES])) {
      await enqueueDelayedJob(
        this.db,
        {
          type: CONNECTOR_SYNC_JOB_TYPE,
          payload: {
            source_type: 'connector',
            source_id: connector.id,
            principal_id: connector.ownerId,
          },
        },
        0,
      );
    }
  }
}
