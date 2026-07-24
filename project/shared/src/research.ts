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

/** One ranked discovery result. `score` is SearXNG's aggregate relevance
 * (higher = more relevant, null if absent); it drives auto-selection of the best
 * sources so the user never has to pick (decision 0050). */
export interface DiscoveredPageDto {
  url: string;
  title: string;
  snippet: string;
  score: number | null;
}

/**
 * Auto-select the best sources by relevance score (decision 0050): most-relevant
 * first, nulls last but still preferred over dropping a result, capped at `k`.
 * Pure + deterministic so it is unit-tested and identical on every surface.
 */
export function selectTopByScore(results: DiscoveredPageDto[], k = 3): string[] {
  return [...results]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.score ?? -Infinity) - (a.r.score ?? -Infinity) || a.i - b.i)
    .slice(0, k)
    .map(({ r }) => r.url);
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

/* ── Research runs: the show-edit-approve gate (Part B, decisions 0044/0045) ── */

export type ResearchRunStatus = 'proposed' | 'approved' | 'cancelled';

export interface ProposeResearchRequest {
  /** What the user asked for, verbatim (search box input or chat message). */
  intent: string;
}

/**
 * The gate's disclosure: the original intent, the proposed query, the
 * minimised query, and the one-line reason for what was removed or kept.
 * NOTHING has been sent when this is returned.
 */
export interface ResearchRunDto {
  id: string;
  status: ResearchRunStatus;
  intent: string;
  proposedQuery: string;
  minimisedQuery: string;
  minimiseReason: string;
  /** The exact text that left the instance; null until approved. */
  sentQuery: string | null;
  answer: string | null;
  createdAt: string;
  approvedAt: string | null;
  cancelledAt: string | null;
}

export interface ApproveResearchRequest {
  /** The final query text — the user may have edited it freely at the gate. */
  query: string;
}

/**
 * One captured page's pipeline progress under a run (decision 0047 — the
 * in-chat research flow's honest wait): the queue-ledger state plus how many
 * facts the page has yielded so far.
 */
export interface ResearchRunPageProgressDto {
  id: string;
  url: string;
  title: string | null;
  state: WebProcessingState;
  factCount: number;
}

/** GET /api/research/runs/:id/progress — owner-gated, chat's progress feed. */
export interface ResearchRunProgressDto {
  runId: string;
  pages: ResearchRunPageProgressDto[];
}

/** Approval's result: discovery ran with the recorded query. */
export interface ApproveResearchResponse {
  run: ResearchRunDto;
  search: ResearchSearchResponse;
}

export interface ResearchCaptureForRunRequest {
  urls: string[];
}

/** One resolved citation of the synthesised answer. */
export type ResearchCitationDto =
  | {
      kind: 'web';
      marker: string;
      url: string;
      title: string | null;
      fetchedAt: string;
      webPageId: string;
    }
  | { kind: 'memory'; marker: string; memoryId: string };

export interface ResearchAnswerDto {
  runId: string;
  /** Answer text containing the [W#]/[M#] markers the citations resolve. */
  answer: string;
  citations: ResearchCitationDto[];
}

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
  /**
   * The approved query that led to this page (Part B): the exact text that
   * left the instance, resolved from the page's research run. Null for direct
   * URL captures. This makes "what was searched to learn this fact" part of
   * every research-derived memory's inspectable provenance.
   */
  sentQuery: string | null;
}
