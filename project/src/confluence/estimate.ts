import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConnectorCredentialOpener } from '../identity/index';
import { ConnectorStore } from '../connectors/index';
import { ConfluenceClient } from './client';
import { CONFLUENCE_KIND } from './descriptor';

/** Count requests one estimate pass may spend. */
const ESTIMATE_MAX_SCOPES = 100;

/**
 * The worker half of the honest backfill estimate (V2.5 item 8.2, issue
 * B2): one CQL count per scope for the connector's CURRENT backfill
 * settings, selected scopes first, written to the platform's sub-scope
 * stats. Counting is estimation, not sync: a rate-limited or failing count
 * aborts the remainder and leaves whatever was already recorded, and the
 * user sees exactly the scopes that have numbers.
 */
@Injectable()
export class ConfluenceEstimateService {
  private readonly logger = new Logger(ConfluenceEstimateService.name);

  constructor(
    private readonly store: ConnectorStore,
    @Optional() private readonly opener?: ConnectorCredentialOpener,
  ) {}

  async estimate(connectorId: string): Promise<void> {
    const row = await this.store.byId(connectorId);
    if (!row || row.kind !== CONFLUENCE_KIND) return;
    if (!this.opener) throw new Error('the estimate requires the credential opener (worker)');
    const opened = await this.opener.open(connectorId);
    if (!opened) return;
    const extras = opened.material.extras ?? {};
    const siteUrl = extras.siteUrl;
    const email = extras.email;
    if (!siteUrl || !email) return;
    const client = new ConfluenceClient({
      siteUrl,
      email,
      apiToken: opened.material.accessToken,
    });

    const settings = row.settingsJson ?? {};
    const all = settings.backfillAll ?? false;
    const days = settings.backfillDays ?? 30;
    const since = all ? null : new Date(Date.now() - days * 86_400_000);
    const window = all ? 'all' : since!.toISOString().slice(0, 10);

    const scopes = await this.store.subScopes(connectorId);
    const ordered = [...scopes.filter((s) => s.selected), ...scopes.filter((s) => !s.selected)];
    let spent = 0;
    for (const scope of ordered) {
      if (spent >= ESTIMATE_MAX_SCOPES) break;
      const cql = countCqlFor(scope.key, since);
      if (!cql) continue;
      spent += 1;
      let count: number | null;
      try {
        count = await client.countSearch(cql);
      } catch (error) {
        // Estimation must never wedge a connector: record nothing further
        // and let the user retry.
        this.logger.warn(`estimate aborted for one connector: ${(error as Error).message}`);
        return;
      }
      if (count === null) continue;
      await this.store.recordSubScopeStats(connectorId, scope.key, {
        window,
        estimatedItems: count,
        computedAt: new Date().toISOString(),
      });
    }
  }
}

function countCqlFor(scopeKey: string, since: Date | null): string | null {
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateClause = since
    ? ` and lastmodified >= "${since.getUTCFullYear()}/${pad(since.getUTCMonth() + 1)}/${pad(since.getUTCDate())}"`
    : '';
  const pageMatch = /^page:(\d+)$/.exec(scopeKey);
  if (pageMatch) {
    return `(id = ${pageMatch[1]!} or ancestor = ${pageMatch[1]!}) and type = page${dateClause}`;
  }
  const spaceMatch = /^space:([A-Za-z0-9~._-]+)$/.exec(scopeKey);
  if (spaceMatch) {
    return `space = "${spaceMatch[1]!}" and type = page${dateClause}`;
  }
  return null;
}
