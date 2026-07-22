import { describe, expect, it } from 'vitest';
import { WebDiscoveryService } from './web-discovery.service';
import type { ResearchOptions } from './research-options';

/**
 * searx_client_contract — the discovery client against a mocked SearXNG
 * (decision 0042): parses ranked results, enforces the hard result cap, and
 * classifies every failure mode as the typed, user-surfaceable `unavailable`
 * outcome instead of throwing.
 */

const options = (over: Partial<ResearchOptions> = {}): ResearchOptions => ({
  searxngUrl: 'http://searxng:8080',
  resultCap: 3,
  searchTimeoutMs: 1000,
  fetchTimeoutMs: 1000,
  fetchMaxBytes: 1024 * 1024,
  retainHtml: false,
  ...over,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('searx_client_contract', () => {
  it('parses ranked results (url, title, snippet) from the JSON API', async () => {
    const service = new WebDiscoveryService(options());
    service.fetchImpl = async () =>
      jsonResponse({
        results: [
          { url: 'https://example.org/a', title: 'A', content: 'about a' },
          { url: 'https://example.org/b', title: 'B', content: null },
        ],
      });
    const outcome = await service.search('adriatic foods wholesale terms');
    expect(outcome).toEqual({
      status: 'ok',
      results: [
        { url: 'https://example.org/a', title: 'A', snippet: 'about a' },
        { url: 'https://example.org/b', title: 'B', snippet: '' },
      ],
    });
  });

  it('sends the query via POST — never in the URL (no query logging)', async () => {
    const service = new WebDiscoveryService(options());
    let seenUrl = '';
    let seenMethod = '';
    let seenBody = '';
    service.fetchImpl = async (input, init) => {
      seenUrl = String(input);
      seenMethod = init?.method ?? 'GET';
      seenBody = String(init?.body);
      return jsonResponse({ results: [] });
    };
    await service.search('a confidential query');
    expect(seenMethod).toBe('POST');
    expect(seenUrl).not.toContain('confidential');
    expect(seenBody).toContain('confidential');
  });

  it('respects the hard result cap and drops non-http(s) urls', async () => {
    const service = new WebDiscoveryService(options({ resultCap: 2 }));
    service.fetchImpl = async () =>
      jsonResponse({
        results: [
          { url: 'ftp://example.org/x', title: 'ftp', content: '' },
          { url: 'https://example.org/1', title: '1', content: '' },
          { url: 'https://example.org/2', title: '2', content: '' },
          { url: 'https://example.org/3', title: '3', content: '' },
        ],
      });
    const outcome = await service.search('anything');
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.results.map((r) => r.url)).toEqual([
        'https://example.org/1',
        'https://example.org/2',
      ]);
    }
  });

  it('classifies engine-down, HTTP errors and bad JSON as typed unavailability', async () => {
    const down = new WebDiscoveryService(options());
    down.fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await down.search('q')).toMatchObject({ status: 'unavailable' });

    const rateLimited = new WebDiscoveryService(options());
    rateLimited.fetchImpl = async () => jsonResponse({}, 429);
    expect(await rateLimited.search('q')).toMatchObject({ status: 'unavailable' });

    const garbled = new WebDiscoveryService(options());
    garbled.fetchImpl = async () => new Response('<html>not json</html>', { status: 200 });
    expect(await garbled.search('q')).toMatchObject({ status: 'unavailable' });
  });

  it('reports unconfigured discovery as unavailable with a pointer to the profile', async () => {
    const service = new WebDiscoveryService(options({ searxngUrl: null }));
    const outcome = await service.search('q');
    expect(outcome.status).toBe('unavailable');
    if (outcome.status === 'unavailable') {
      expect(outcome.reason).toContain('research');
    }
  });
});
