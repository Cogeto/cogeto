import { Injectable } from '@nestjs/common';
import { ConnectorStore } from './persistence/connector-store';

/**
 * The capability surface's view of the connector fleet (V2.5 item 8.1,
 * issue A4): implemented here, consumed by operations through its
 * CONNECTOR_HEALTH port (the CAPABILITY_JOB_SOURCES pattern), bound by the
 * composition roots. Counts and reasons only; the actionable message is
 * assembled by the capability entry.
 */

export interface ConnectorFleetSummary {
  configured: number;
  healthy: number;
  syncing: number;
  degraded: { name: string | null; reason: string | null }[];
  needsReauth: { name: string | null }[];
  disabled: number;
}

@Injectable()
export class ConnectorHealthSource {
  constructor(private readonly store: ConnectorStore) {}

  async summary(): Promise<ConnectorFleetSummary> {
    const rows = await this.store.listInStates([
      'configured',
      'authorised',
      'syncing',
      'healthy',
      'degraded',
      'needs_reauth',
      'disabled',
    ]);
    return {
      configured: rows.length,
      healthy: rows.filter((r) => r.state === 'healthy' || r.state === 'authorised').length,
      syncing: rows.filter((r) => r.state === 'syncing').length,
      degraded: rows
        .filter((r) => r.state === 'degraded')
        .map((r) => ({ name: r.name, reason: r.statusReason })),
      needsReauth: rows.filter((r) => r.state === 'needs_reauth').map((r) => ({ name: r.name })),
      disabled: rows.filter((r) => r.state === 'disabled').length,
    };
  }
}
