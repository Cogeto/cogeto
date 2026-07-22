/**
 * Web-research wiring (Priority 5 Part A; decisions 0042/0043) — resolved from
 * validated config by the composition roots, injected where discovery and the
 * fetcher enforce it. Values, not env reads: only entrypoints touch the
 * environment.
 */
export interface ResearchOptions {
  /** SearXNG base URL on the internal network; null → discovery unavailable. */
  searxngUrl: string | null;
  /** Hard cap on ranked results a single discovery query returns. */
  resultCap: number;
  /** Abort a discovery query after this long. */
  searchTimeoutMs: number;
  /** Abort a single page fetch (including redirects) after this long. */
  fetchTimeoutMs: number;
  /** Hard cap on a fetched response body, bytes; larger pages are skipped. */
  fetchMaxBytes: number;
  /** Retain the sanitised raw HTML as a scoped MinIO object (decision 0043 —
   * default off: the extracted clean text + URL are the source of record). */
  retainHtml: boolean;
}

export const RESEARCH_OPTIONS = Symbol('RESEARCH_OPTIONS');
