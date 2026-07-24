import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { RESEARCH_OPTIONS } from './research-options';
import type { ResearchOptions } from './research-options';

/**
 * Discovery (decision 0042): given a query, the self-hosted SearXNG instance
 * returns ranked public URLs with title and snippet. Discovery is a DISTINCT
 * capability from model inference — it never goes through the model gateway,
 * carries its own caps, and degrades to a typed, user-surfaceable
 * "search unavailable" instead of crashing: a down or rate-limited engine is an
 * expected condition, not an error path.
 *
 * Only ranked http(s) URLs leave this client; result count is hard-capped
 * (options.resultCap) and the query itself is never logged (neither here nor in
 * SearXNG — its config disables metrics and runs at WARNING log level).
 */

export interface DiscoveredPage {
  url: string;
  title: string;
  snippet: string;
  /** SearXNG's aggregate relevance score (higher = more relevant), null if the
   * engine did not provide one. Used to auto-select the best sources without
   * asking the user to pick (decision 0050). */
  score: number | null;
}

export type DiscoveryOutcome =
  { status: 'ok'; results: DiscoveredPage[] } | { status: 'unavailable'; reason: string };

/** The subset of SearXNG's JSON response discovery consumes. */
const searxResponseSchema = z.object({
  results: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().default(''),
        content: z.string().nullish(),
        score: z.number().nullish(),
      }),
    )
    .default([]),
});

@Injectable()
export class WebDiscoveryService {
  private readonly log = new Logger(WebDiscoveryService.name);
  /** Injection seam for tests (searx_client_contract) — defaults to global fetch. */
  fetchImpl: typeof fetch = (...args) => fetch(...args);

  constructor(@Inject(RESEARCH_OPTIONS) private readonly options: ResearchOptions) {}

  async search(query: string): Promise<DiscoveryOutcome> {
    if (!this.options.searxngUrl) {
      return {
        status: 'unavailable',
        reason:
          'search is not configured on this instance — bring the `research` compose profile up',
      };
    }
    const target = new URL('/search', this.options.searxngUrl);
    // POST keeps the query out of URLs and any request-line/access logging —
    // part of the no-query-logging posture (decision 0042).
    const form = new URLSearchParams({ q: query, format: 'json' });

    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(this.options.searchTimeoutMs),
        headers: { accept: 'application/json' },
      });
    } catch {
      // Network failure / timeout — never the query in the log line.
      this.log.warn('discovery request failed (network or timeout)');
      return { status: 'unavailable', reason: 'search is unavailable right now — try again' };
    }
    if (!response.ok) {
      this.log.warn(`discovery request failed (status ${response.status})`);
      return { status: 'unavailable', reason: 'search is unavailable right now — try again' };
    }

    let parsed: z.infer<typeof searxResponseSchema>;
    try {
      parsed = searxResponseSchema.parse(await response.json());
    } catch {
      this.log.warn('discovery response was not the expected JSON shape');
      return { status: 'unavailable', reason: 'search is unavailable right now — try again' };
    }

    const results = parsed.results
      .filter((r) => /^https?:\/\//i.test(r.url))
      .slice(0, this.options.resultCap)
      .map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.content ?? '',
        score: r.score ?? null,
      }));
    return { status: 'ok', results };
  }
}
