/**
 * Web-research wiring — resolved from
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
  /** Retain the sanitised raw HTML as a scoped MinIO object (—
   * default off: the extracted clean text + URL are the source of record). */
  retainHtml: boolean;
  /**
   * Fixture-backed web (the Ana sandbox): when present,
   * discovery returns exactly these pages and the fetcher serves their HTML —
   * NOTHING real is searched or fetched. Set only by the demo composition;
   * production instances never populate it.
   */
  fixtures?: WebFixturePage[];
}

export interface WebFixturePage {
  url: string;
  title: string;
  html: string;
}

export const RESEARCH_OPTIONS = Symbol('RESEARCH_OPTIONS');
