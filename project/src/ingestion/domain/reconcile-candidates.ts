import type { FactKind } from '@cogeto/shared';
import {
  CONTRADICTION_KINDS,
  ENTITY_OVERLAP_MIN,
  type ReconcileThresholds,
} from '../reconcile-config';
import {
  canonicalEntityOverlap,
  entityNamesMatch,
  EMPTY_ALIAS_INDEX,
  EntityAliasIndex,
  foldEntityName,
} from './entity-match';

/**
 * The deterministic candidate rules, pure so the
 * pipeline driver, the dreaming driver, and the eval harness apply
 * EXACTLY the same gate before any model call. Similarities are the
 * normalized [0,1] scores; `null` similarity means the pair reached us
 * through the entity or subject path only.
 *
 * v2 (V2.3 item 6.1): thresholds arrive as a parameter (calibrated per
 * embedding model), subject identity is alias-aware, and the escalation rule
 * covers `related` as well as `distinct` — a paraphrased conflict embeds
 * nearly identically, and the dedup judge frequently calls the pair `related`
 * rather than `distinct`, which used to make it structurally invisible.
 */

export interface CandidateFacts {
  kind: FactKind | null;
  entities: string[];
  subjectEntity: string | null;
}

/** How two subjects were matched; 'none' means they are not the same entity. */
export type SubjectMatch = 'none' | 'folded' | 'alias' | 'typo';

/**
 * Alias-aware subject identity with the match kind, because the candidate
 * gate treats an alias match as stronger evidence than a folded one (a
 * recorded cross-language equivalence outranks an embedding-space proxy).
 */
export function subjectMatchKind(
  a: CandidateFacts,
  b: CandidateFacts,
  aliases: EntityAliasIndex = EMPTY_ALIAS_INDEX,
): SubjectMatch {
  if (!a.subjectEntity || !b.subjectEntity) return 'none';
  const foldA = foldEntityName(a.subjectEntity);
  const foldB = foldEntityName(b.subjectEntity);
  if (!foldA || !foldB) return 'none';
  if (foldA === foldB) return 'folded';
  if (aliases.keyOf(a.subjectEntity) === aliases.keyOf(b.subjectEntity)) return 'alias';
  return entityNamesMatch(a.subjectEntity, b.subjectEntity, aliases) ? 'typo' : 'none';
}

/** Dedup path 1: embedding proximity above the calibrated threshold. */
export function dedupBySimilarity(
  similarity: number | null,
  thresholds: ReconcileThresholds,
): boolean {
  return similarity !== null && similarity >= thresholds.dedupSimilarity;
}

/** Dedup path 2: strong canonical entity overlap plus kind match. */
export function dedupByEntities(
  a: CandidateFacts,
  b: CandidateFacts,
  aliases: EntityAliasIndex = EMPTY_ALIAS_INDEX,
): boolean {
  if (!a.kind || !b.kind || a.kind !== b.kind) return false;
  return canonicalEntityOverlap(a.entities, b.entities, aliases) >= ENTITY_OVERLAP_MIN;
}

export function isDedupCandidate(
  similarity: number | null,
  a: CandidateFacts,
  b: CandidateFacts,
  thresholds: ReconcileThresholds,
  aliases: EntityAliasIndex = EMPTY_ALIAS_INDEX,
): boolean {
  return dedupBySimilarity(similarity, thresholds) || dedupByEntities(a, b, aliases);
}

/** What the dedup judge ruled for a pair, where it ruled at all. */
export type DedupRuling = 'distinct' | 'related' | null;

/**
 * Contradiction candidates: shared subject (alias-aware), contradiction-
 * capable kinds on both sides, and a similarity rule that depends on HOW the
 * subjects matched. Pre-F2 rows (kind or subject NULL) never qualify:
 * conservative by design.
 *
 * - Above the dedup threshold, the pair reaches the contradiction check after
 *   ANY non-merge dedup ruling (`distinct` OR `related` — the escalation
 *   hole this unit closes: only `distinct` escalated before, so a
 *   high-similarity paraphrased conflict the judge called `related` was
 *   structurally invisible). A pair that was never dedup-ELIGIBLE (a
 *   `contradicted` candidate, which the merge path rightly refuses) cannot
 *   produce a ruling, so it escalates directly — the revision-fix case is
 *   exactly a high-similarity restatement against a contradicted party.
 * - `null` similarity (the entity/subject path found the pair) qualifies:
 *   the old lower bound silently excluded these, which was the same hole at
 *   the bottom of the band.
 * - Below the floor, only an ALIAS-matched subject qualifies: recorded
 *   cross-language names legitimately embed far apart; fold-equal subjects
 *   below the floor are the owner's many unrelated facts about one person.
 */
export function isContradictionCandidate(
  similarity: number | null,
  a: CandidateFacts,
  b: CandidateFacts,
  thresholds: ReconcileThresholds,
  dedupRuling: DedupRuling = null,
  aliases: EntityAliasIndex = EMPTY_ALIAS_INDEX,
  opts: { dedupEligible?: boolean } = {},
): boolean {
  const match = subjectMatchKind(a, b, aliases);
  if (match === 'none') return false;
  if (!a.kind || !CONTRADICTION_KINDS.includes(a.kind)) return false;
  if (!b.kind || !CONTRADICTION_KINDS.includes(b.kind)) return false;
  if (similarity === null) return true;
  if (similarity >= thresholds.dedupSimilarity) {
    if (opts.dedupEligible === false) return true;
    return dedupRuling === 'distinct' || dedupRuling === 'related';
  }
  if (similarity < thresholds.contradictionFloor) return match === 'alias';
  return true;
}
