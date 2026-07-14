import type { MemoryListItem } from './notes';

/**
 * Time-travel DTOs (decision 0012, §B.2): the presentation surface over the
 * memory module's temporal primitives (pointInTime, changesSince, the
 * supersession chain). No new retrieval semantics or schema live here — these
 * types only *shape* what those primitives already return so the timeline UI
 * and a temporal chat answer tell the same story.
 *
 * The one interval predicate (decision 0012 ruling 1) is never re-encoded here:
 * "holds at t" is decided server-side by pointInTime. What this module owns is
 * the past-framing contract (ruling 6) — the same replaced/outdated/closed
 * shape the chat citation chip already renders — and the pure set arithmetic of
 * a between-two-points diff, both testable without a model.
 */

/** How a subject's timeline is addressed: an entity name is the subject. */
export interface TimelineSpan {
  /** The fact itself — status, scope, source, validity, successor pointer. */
  memory: MemoryListItem;
  /**
   * When the belief took effect for display: `valid_from`, or `created_at`
   * when `valid_from` is NULL ("since ingestion"). This is the interval's lower
   * bound, not a holds-at-t evaluation.
   */
  effectiveFrom: string;
  /** `valid_until`, or null = still holding. */
  effectiveUntil: string | null;
  /**
   * Past belief (decision 0012 ruling 6): replaced/outdated, or the interval
   * closed before now. Rendered muted, exactly like the chat "past" chip.
   */
  pastBelief: boolean;
  /** Currently held: the interval is open at now AND this is not a past belief. */
  current: boolean;
  /** Successor memory id when this fact was superseded; one click to what replaced it. */
  supersededBy: string | null;
}

/** GET /api/timeline?subject= — a subject's full history as validity spans. */
export interface TimelineDto {
  /** The subject entity this timeline is about. */
  subject: string;
  /** Every fact about the subject, newest effective-from first. */
  spans: TimelineSpan[];
}

/**
 * What became of a belief that held at the asked-about instant, by now — the
 * label that keeps a point-in-time view honest ("you believed X then; it was
 * later replaced").
 */
export type LaterFate = 'still_current' | 'replaced' | 'outdated' | 'expired';

export interface PointInTimeFact {
  memory: MemoryListItem;
  /** What later happened to this belief (decision 0012 ruling 3 pointer + status). */
  laterFate: LaterFate;
  /** Successor memory id when the later fate is `replaced`. */
  supersededBy: string | null;
}

/** GET /api/timeline/at?subject=&at= — the subject as Cogeto understood it then. */
export interface PointInTimeDto {
  subject: string;
  /** The instant asked about (ISO). */
  at: string;
  /** Facts holding at `at`, each labelled with what became of it later. */
  facts: PointInTimeFact[];
}

/** One belief that changed across the window: X at `from` became Y at `to`. */
export interface TimelineChange {
  before: MemoryListItem;
  after: MemoryListItem;
}

/**
 * GET /api/timeline/diff?subject=&from=&to= — the diff reading between two
 * points, in the ruling-4 vocabulary: what was learned, what changed, what
 * became outdated, what stayed.
 */
export interface TimelineDiffDto {
  subject: string;
  from: string;
  to: string;
  /** Facts learned in the window: held at `to`, not the successor of a change. */
  added: MemoryListItem[];
  /** Beliefs superseded in the window (X → Y). */
  changed: TimelineChange[];
  /** Facts that dropped out with no successor at `to` (became outdated/expired). */
  removed: MemoryListItem[];
  /** Facts unchanged across the window (held at both points). */
  unchanged: MemoryListItem[];
}

/**
 * The past-framing contract as a client/server twin (decision 0012 ruling 6),
 * enriched with what specifically became of a fact — used to label a
 * point-in-time view. Pure and time-injectable so the label is deterministic in
 * tests; it evaluates the closed-interval / status arms only, never the
 * holds-at-t predicate (that stays single, in the memory module).
 */
export function laterFateOf(
  memory: Pick<MemoryListItem, 'status' | 'validUntil' | 'supersededBy'>,
  now: number = Date.now(),
): LaterFate {
  if (memory.status === 'replaced' || memory.supersededBy) return 'replaced';
  if (memory.status === 'outdated') return 'outdated';
  if (memory.validUntil !== null && new Date(memory.validUntil).getTime() <= now) return 'expired';
  return 'still_current';
}

/**
 * The diff between two point-in-time snapshots of one subject — pure set
 * arithmetic over the gated facts each `pointInTime` call already returned, so
 * it is testable without a model or a database (decision 0012 ruling 4 shape).
 *
 * `factsAtFrom` / `factsAtTo` are the facts that HELD at each instant (the
 * interval predicate already applied server-side). Supersession is followed
 * forward through `superseded_by`, multi-hop, but only across facts present in
 * the two snapshots — an intermediate version that held at neither instant
 * resolves the predecessor to `removed` and its eventual successor to `added`,
 * which is the honest reading of "we can't see the middle".
 */
export function computeTimelineDiff(
  factsAtFrom: MemoryListItem[],
  factsAtTo: MemoryListItem[],
): Omit<TimelineDiffDto, 'subject' | 'from' | 'to'> {
  const fromIds = new Set(factsAtFrom.map((m) => m.id));
  const toIds = new Set(factsAtTo.map((m) => m.id));
  const toById = new Map(factsAtTo.map((m) => [m.id, m]));
  const union = new Map<string, MemoryListItem>();
  for (const m of [...factsAtFrom, ...factsAtTo]) union.set(m.id, m);

  // Follow the successor chain forward until it lands on a fact that held at
  // `to`; null when it leaves the two snapshots without arriving.
  const successorAtTo = (start: MemoryListItem): MemoryListItem | null => {
    const seen = new Set<string>([start.id]);
    let pointer = start.supersededBy;
    while (pointer && !seen.has(pointer)) {
      seen.add(pointer);
      if (toIds.has(pointer)) return toById.get(pointer)!;
      pointer = union.get(pointer)?.supersededBy ?? null;
    }
    return null;
  };

  const changed: TimelineChange[] = [];
  const removed: MemoryListItem[] = [];
  const changedAfterIds = new Set<string>();
  for (const memory of factsAtFrom) {
    if (toIds.has(memory.id)) continue; // still holds → unchanged
    const after = successorAtTo(memory);
    if (after) {
      changed.push({ before: memory, after });
      changedAfterIds.add(after.id);
    } else {
      removed.push(memory);
    }
  }

  const unchanged = factsAtFrom.filter((m) => toIds.has(m.id));
  const added = factsAtTo.filter((m) => !fromIds.has(m.id) && !changedAfterIds.has(m.id));
  return { added, changed, removed, unchanged };
}
