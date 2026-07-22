import type { MemoryScope } from './memory';

/**
 * Web research DTOs (Priority 5 Part A; decisions 0042/0043): explicit
 * discovery (POST /api/research/search), selected-page capture
 * (POST /api/research/capture), and the web source drawer
 * (GET /api/research/:id/source).
 */

export interface ResearchSearchRequest {
  query: string;
}

/** One ranked discovery result the user can select for capture. */
export interface DiscoveredPageDto {
  url: string;
  title: string;
  snippet: string;
}

/**
 * Discovery degrades honestly: a down/rate-limited engine is `unavailable`
 * with a user-surfaceable reason, never a 500.
 */
export type ResearchSearchResponse =
  { status: 'ok'; results: DiscoveredPageDto[] } | { status: 'unavailable'; reason: string };

export interface ResearchCaptureRequest {
  urls: string[];
  scope?: MemoryScope;
}

/** Per-URL capture outcome — every skip is annotated, nothing silent. */
export type CaptureResultDto =
  | { url: string; status: 'captured'; id: string; title: string | null }
  | { url: string; status: 'skipped'; reason: string; detail: string };

export interface ResearchCaptureResponse {
  results: CaptureResultDto[];
}

/** Same queue-ledger derivation as NoteProcessingState. */
export type WebProcessingState = 'processing' | 'done' | 'failed';

/** The web source drawer: the page as Cogeto retained it, URL one click away. */
export interface WebSourceDto {
  id: string;
  requestedUrl: string;
  finalUrl: string;
  title: string | null;
  fetchedAt: string;
  retainedText: string;
  scope: MemoryScope;
  sensitive: boolean;
  state: WebProcessingState;
}
