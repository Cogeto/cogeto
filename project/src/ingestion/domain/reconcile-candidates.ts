import type { FactKind } from '@cogeto/shared';
import {
  CONTRADICTION_BAND_LOW,
  CONTRADICTION_KINDS,
  DEDUP_SIMILARITY,
  ENTITY_OVERLAP_MIN,
  entityOverlap,
  normalizeEntity,
} from '../reconcile-config';

/**
 * The deterministic candidate rules (decision 0010 ruling 6), pure so the
 * pipeline driver, the F2-B dreaming driver, and the eval harness apply
 * EXACTLY the same gate before any model call. Similarities are the
 * normalized [0,1] scores; `null` similarity means the pair reached us
 * through the entity path only.
 */

export interface CandidateFacts {
  kind: FactKind | null;
  entities: string[];
  subjectEntity: string | null;
}

/** Dedup path 1: embedding proximity above the config threshold. */
export function dedupBySimilarity(similarity: number | null): boolean {
  return similarity !== null && similarity >= DEDUP_SIMILARITY;
}

/** Dedup path 2: strong entity overlap plus kind match (both kinds known). */
export function dedupByEntities(a: CandidateFacts, b: CandidateFacts): boolean {
  if (!a.kind || !b.kind || a.kind !== b.kind) return false;
  return entityOverlap(a.entities, b.entities) >= ENTITY_OVERLAP_MIN;
}

export function isDedupCandidate(
  similarity: number | null,
  a: CandidateFacts,
  b: CandidateFacts,
): boolean {
  return dedupBySimilarity(similarity) || dedupByEntities(a, b);
}

/**
 * Contradiction candidates: shared subject, contradiction-capable kinds on
 * both sides, similarity in the mid band — similar topic, different content.
 * Pre-F2 rows (kind or subject NULL) never qualify: conservative by design.
 *
 * `dedupJudgedDistinct` is the escalation rule (0010 ruling 6): a pair ABOVE
 * the dedup threshold ("go-live October 1" vs "go-live September 1" embeds
 * nearly identically) reaches the contradiction check only after the dedup
 * model ruled it `distinct` — same slot, different value is precisely what
 * that verdict flags. Without escalation, high-similarity contradictions
 * would be invisible to reconciliation.
 */
export function isContradictionCandidate(
  similarity: number | null,
  a: CandidateFacts,
  b: CandidateFacts,
  dedupJudgedDistinct = false,
): boolean {
  if (similarity === null || similarity < CONTRADICTION_BAND_LOW) return false;
  if (similarity >= DEDUP_SIMILARITY && !dedupJudgedDistinct) return false;
  if (!a.subjectEntity || !b.subjectEntity) return false;
  if (normalizeEntity(a.subjectEntity) !== normalizeEntity(b.subjectEntity)) return false;
  if (!a.kind || !CONTRADICTION_KINDS.includes(a.kind)) return false;
  if (!b.kind || !CONTRADICTION_KINDS.includes(b.kind)) return false;
  return true;
}
