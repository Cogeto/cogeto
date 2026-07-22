import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { DailyCounters } from '../infrastructure/index';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import type { MemoryObjectStore } from '../memory/index';
import { ModelGateway } from '../model-gateway/index';
import { ResearchService } from './research.service';
import { WebDiscoveryService } from './web-discovery.service';
import { WebFetchService } from './web-fetch';
import type { ResearchOptions } from './research-options';

/**
 * The show-edit-approve gate (decision 0045), enforced at the service+schema
 * level: discovery runs ONLY from explicit approval; a cancel sends nothing;
 * the user's edited text is what leaves and what is recorded, immutably.
 */

const owner: Principal = {
  userId: 'user-gate',
  name: 'Gate Owner',
  email: 'gate@instance.test',
  orgId: 'org-gate',
  orgName: 'Org',
  roles: [],
};

const options: ResearchOptions = {
  searxngUrl: 'http://searxng:8080',
  resultCap: 8,
  searchTimeoutMs: 500,
  fetchTimeoutMs: 500,
  fetchMaxBytes: 1024 * 1024,
  retainHtml: false,
};

/** Minimiser scripted at the gateway seam: drops "Adriatic Foods". */
class MinimiserGateway extends ModelGateway {
  complete(): never {
    throw new Error('unused');
  }
  // eslint-disable-next-line require-yield -- unused
  async *completeStream(): AsyncIterable<string> {
    throw new Error('unused');
  }
  async embed(): Promise<number[][]> {
    throw new Error('unused');
  }
  embeddingModelId(): string {
    return 'unused';
  }
  async extractStructured<T>(schema: ZodType<T>): Promise<T> {
    const parsed = schema.safeParse({
      minimised_query: 'GDPR consent requirements CRM migration',
      removed: ['Adriatic Foods'],
      kept: [],
      reason: 'client name removed — the intent is general',
    });
    if (!parsed.success) throw new Error('schema');
    return parsed.data;
  }
}

describe('research gate (integration: real Postgres, spied discovery)', () => {
  let tdb: TestDatabase;
  let research: ResearchService;
  let sentQueries: string[];

  beforeAll(async () => {
    tdb = await startTestDatabase();
    sentQueries = [];
    const discovery = new WebDiscoveryService(options);
    discovery.fetchImpl = async (input, init) => {
      // Record what actually left (the POSTed form body carries the query).
      sentQueries.push(String(init?.body));
      return new Response(
        JSON.stringify({ results: [{ url: 'https://example.org/a', title: 'A' }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };
    const objects = new Proxy(
      {},
      {
        get() {
          throw new Error('unused');
        },
      },
    ) as MemoryObjectStore;
    research = new ResearchService(
      tdb.db,
      discovery,
      new WebFetchService(options),
      objects,
      new DailyCounters(),
      { searchesMax: 100, pagesMax: 100, pagesPerRunMax: 5 },
      options,
      new MinimiserGateway(),
    );
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  const auditActions = async (entityId: string): Promise<string[]> =>
    (
      await tdb.pool.query<{ action: string }>(
        `SELECT action FROM audit_log WHERE entity_type = 'research_run' AND entity_id = $1 ORDER BY created_at`,
        [entityId],
      )
    ).rows.map((r) => r.action);

  it('no_query_without_approval: propose discloses but sends nothing; cancel sends nothing, ever', async () => {
    const run = await research.propose(owner, 'GDPR consent for Adriatic Foods CRM migration');
    expect(run.status).toBe('proposed');
    expect(run.minimisedQuery).toBe('GDPR consent requirements CRM migration');
    expect(run.minimiseReason).toContain('client name removed');
    expect(run.sentQuery).toBeNull();
    expect(sentQueries).toHaveLength(0); // NOTHING left the instance

    const cancelled = await research.cancel(owner, run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(sentQueries).toHaveLength(0);
    // Cancelled is terminal: no late approval can resurrect the query.
    await expect(research.approveAndSearch(owner, run.id, 'anything')).rejects.toMatchObject({
      status: 409,
    });
    expect(sentQueries).toHaveLength(0);
    expect(await auditActions(run.id)).toEqual(['research_run.proposed', 'research_run.cancelled']);
  });

  it('edited_query_used: the user-edited text is what gets sent and what is recorded, immutably', async () => {
    const run = await research.propose(owner, 'GDPR consent for Adriatic Foods CRM migration');
    const edited = 'GDPR consent requirements CRM migration Croatia';
    const { run: approved, search } = await research.approveAndSearch(owner, run.id, edited);

    expect(search.status).toBe('ok');
    expect(sentQueries).toHaveLength(1);
    expect(sentQueries[0]).toContain(encodeURIComponent(edited).replace(/%20/g, '+'));
    expect(approved.status).toBe('approved');
    expect(approved.sentQuery).toBe(edited); // the record IS the sent text

    // Retrying with the SAME recorded query is allowed (engine hiccups);
    // a different text is refused — the record of what left never mutates.
    await research.approveAndSearch(owner, run.id, edited);
    expect(sentQueries).toHaveLength(2);
    await expect(
      research.approveAndSearch(owner, run.id, 'a totally different query'),
    ).rejects.toMatchObject({ status: 409 });
    const persisted = await research.getRun(owner, run.id);
    expect(persisted!.sentQuery).toBe(edited);
    expect(await auditActions(run.id)).toEqual(['research_run.proposed', 'research_run.approved']);
  });

  it('a non-owner cannot see, approve, or cancel a run', async () => {
    const run = await research.propose(owner, 'research something private');
    const stranger = { ...owner, userId: 'someone-else' };
    expect(await research.getRun(stranger, run.id)).toBeNull();
    await expect(research.approveAndSearch(stranger, run.id, 'x')).rejects.toMatchObject({
      status: 404,
    });
    await expect(research.cancel(stranger, run.id)).rejects.toMatchObject({ status: 404 });
  });

  it('capture is gated on an approved run', async () => {
    const run = await research.propose(owner, 'still proposed');
    await expect(
      research.capture(owner, ['https://example.org/a'], 'private', run.id),
    ).rejects.toMatchObject({ status: 409 });
  });
});
