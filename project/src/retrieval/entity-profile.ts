import type { MemoryRow } from '../memory/index';
import { STATUS_MULTIPLIERS } from '@cogeto/shared';
import { QUERY_ENTITY_STOPWORDS } from './retrieval-config';

/**
 * Entity-profile retrieval helpers (S3.5-B, F1/F4/F5). Detection is fully
 * deterministic: a who-is / tell-me-about question with exactly one focus
 * entity. In that mode retrieval gathers ALL of the entity's memories
 * (exhaustive, not top-k) so the answer can be a complete profile.
 */

/** Who-is / tell-me-about intent — a person/entity profile, not a scope question. */
const ENTITY_INTENT =
  /\b(who\s+(is|are|was|were)|who'?s|tell me (about|more about)|remind me who|what do (i|we) know about|what can you tell me about)\b/i;

/**
 * The focus entity when the query is an entity-profile question with exactly one
 * candidate entity, else null. `candidates` come from the rewriter (or the
 * heuristic fallback).
 */
export function detectEntityProfile(query: string, candidates: string[]): string | null {
  const unique = [...new Set(candidates.map((c) => c.trim()).filter(Boolean))];
  if (unique.length !== 1) return null;
  return ENTITY_INTENT.test(query) ? unique[0]! : null;
}

/** Full name plus its significant tokens — so "Ana Kovač" also matches stored "Ana". */
export function nameVariants(entity: string): string[] {
  const full = entity.trim();
  const tokens = full
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}'’-]/gu, ''))
    .filter((t) => t.length >= 2 && !QUERY_ENTITY_STOPWORDS.has(t.toLowerCase()));
  return [...new Set([full, ...tokens])].filter(Boolean);
}

/** Does this memory actually concern the entity (not merely a vector neighbour)? */
export function mentionsEntity(row: MemoryRow, entity: string): boolean {
  const variants = nameVariants(entity).map((v) => v.toLowerCase());
  const subject = row.subjectEntity?.toLowerCase() ?? '';
  const entities = row.entities.map((e) => e.toLowerCase());
  const content = (row.content ?? '').toLowerCase();
  return variants.some(
    (v) => subject.includes(v) || entities.some((e) => e.includes(v)) || content.includes(v),
  );
}

/** Order for a profile / aggregated result: trust (status weight) then recency. */
export function byStatusThenRecency(a: MemoryRow, b: MemoryRow): number {
  const wa = STATUS_MULTIPLIERS[a.status];
  const wb = STATUS_MULTIPLIERS[b.status];
  if (wb !== wa) return wb - wa;
  return b.createdAt.getTime() - a.createdAt.getTime();
}

/**
 * The entity shared by a dominant share of the fused results, if any — the
 * trigger to widen a project/topic answer once (F5). Counts an entity when it
 * appears in a row's entities[] or is its subject; returns the top such entity
 * present in ≥2 rows and ≥40% of them.
 */
export function dominantEntity(rows: MemoryRow[]): string | null {
  if (rows.length < 2) return null;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const names = new Set<string>();
    for (const e of row.entities) names.add(e);
    if (row.subjectEntity) names.add(row.subjectEntity);
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best && bestCount >= 2 && bestCount >= Math.ceil(rows.length * 0.4) ? best : null;
}
