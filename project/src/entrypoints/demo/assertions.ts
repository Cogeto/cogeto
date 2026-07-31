import type { Pool } from 'pg';

/**
 * The seed's end-state assertions. After the corpus has
 * been fed through the real pipeline and one dreaming cycle has run, the
 * fictional world must have materialized as designed — a silently wrong sandbox
 * is worse than none, so the seed FAILS LOUDLY when a hard assertion does not
 * hold. Reads only (SQL SELECT) — it writes nothing.
 *
 * Assertions are deliberately tolerant of extraction variance (ranges/presence,
 * not exact counts): the pipeline is a real LLM, not a fixture.
 */

export interface DemoEndState {
  statusCounts: Record<string, number>;
  memories: number;
  contradictionRelations: number;
  replaced: number;
  openLoops: number;
  dueDatedLoops: number;
  dormantLoops: number;
  documentMemories: number;
  markoCommitments: number;
  hardFailures: string[];
  softWarnings: string[];
}

const MIN_ACTIVE = 8;
/** The world must contain standing obligations — the open-loops answer's input
 * (: read from memory, no derived table behind them). */
const MIN_OPEN_LOOPS = 3;

/** Kinds and statuses that make a memory an OPEN LOOP — the same definition
 * MemoryStore.openLoopsForPrincipal applies, kept in SQL here because the
 * assertions read the seeded database directly. */
const OPEN_LOOP_PREDICATE = `kind IN ('commitment', 'open_loop')
     AND status IN ('active', 'user_approved', 'uncertain')`;

export async function inspectEndState(pool: Pool, ownerId: string): Promise<DemoEndState> {
  const statusRows = await pool.query<{ status: string; n: string }>(
    'SELECT status, count(*)::text AS n FROM memory WHERE owner_id = $1 GROUP BY status',
    [ownerId],
  );
  const statusCounts: Record<string, number> = {};
  for (const r of statusRows.rows) statusCounts[r.status] = Number(r.n);
  const memories = Object.values(statusCounts).reduce((a, b) => a + b, 0);

  const one = async (sql: string, params: unknown[] = []): Promise<number> => {
    const { rows } = await pool.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n ?? '0');
  };

  const contradictionRelations = await one(
    `SELECT count(*)::text AS n FROM memory_relation
       WHERE kind = 'contradicts' AND resolution IS NULL`,
  );
  const replaced = statusCounts['replaced'] ?? 0;
  const openLoops = await one(
    `SELECT count(*)::text AS n FROM memory WHERE owner_id = $1 AND ${OPEN_LOOP_PREDICATE}`,
    [ownerId],
  );
  const dueDatedLoops = await one(
    `SELECT count(*)::text AS n FROM memory
       WHERE owner_id = $1 AND valid_until IS NOT NULL AND ${OPEN_LOOP_PREDICATE}`,
    [ownerId],
  );
  const dormantLoops = await one(
    `SELECT count(*)::text AS n FROM dormant_flag f
       JOIN memory m ON m.id = f.memory_id
      WHERE m.owner_id = $1 AND f.cleared_at IS NULL`,
    [ownerId],
  );
  const documentMemories = await one(
    `SELECT count(*)::text AS n FROM memory WHERE owner_id = $1 AND source_type = 'file'`,
    [ownerId],
  );
  const markoCommitments = await one(
    `SELECT count(*)::text AS n FROM memory
       WHERE owner_id = $1 AND kind = 'commitment'
         AND status IN ('active', 'contradicted', 'user_approved')
         AND content ILIKE '%marko%'`,
    [ownerId],
  );

  const uncertainWithoutReason = await one(
    `SELECT count(*)::text AS n FROM memory
       WHERE owner_id = $1 AND status = 'uncertain' AND uncertainty_reason IS NULL`,
    [ownerId],
  );
  const suppressedEntries = await one(
    `SELECT count(*)::text AS n FROM suppressed_fact_log WHERE owner_id = $1`,
    [ownerId],
  );

  const active = statusCounts['active'] ?? 0;
  const contradicted = statusCounts['contradicted'] ?? 0;
  const outdated = statusCounts['outdated'] ?? 0;
  const uncertain = statusCounts['uncertain'] ?? 0;

  const hardFailures: string[] = [];
  const softWarnings: string[] = [];
  const need = (cond: boolean, msg: string): void => {
    if (!cond) hardFailures.push(msg);
  };
  const want = (cond: boolean, msg: string): void => {
    if (!cond) softWarnings.push(msg);
  };

  need(active >= MIN_ACTIVE, `expected ≥ ${MIN_ACTIVE} active memories, got ${active}`);
  need(
    contradictionRelations >= 1 && contradicted >= 2,
    `expected the go-live contradiction pair (≥1 relation, ≥2 contradicted), got ${contradictionRelations} relation(s) / ${contradicted} contradicted`,
  );
  need(outdated >= 1, `expected ≥ 1 outdated (lapsed) memory, got ${outdated}`);
  need(uncertain >= 1, `expected ≥ 1 uncertain (hedged) memory, got ${uncertain}`);
  // V2.0 item 3.3: an uncertain fact is admitted with a NAMED reason, and the
  // demo has to show that rather than an undifferentiated bucket — there is no
  // queue left to review it in, so the reason is the whole explanation.
  need(
    uncertainWithoutReason === 0,
    `expected every uncertain memory to name its reason, got ${uncertainWithoutReason} without one`,
  );
  need(
    suppressedEntries >= 1,
    `expected ≥ 1 suppressed-fact log entry explaining an automatic decision, got ${suppressedEntries}`,
  );
  need(
    openLoops >= MIN_OPEN_LOOPS,
    `expected ≥ ${MIN_OPEN_LOOPS} standing open loops, got ${openLoops}`,
  );
  need(
    documentMemories >= 1,
    `expected ≥ 1 memory derived from the uploaded document, got ${documentMemories}`,
  );
  need(
    markoCommitments >= 1,
    `expected ≥ 1 Marko commitment memory (the "what did Ana promise Marko" answer), got ${markoCommitments}`,
  );

  want(replaced >= 1, `expected a supersession chain (≥1 replaced memory), got ${replaced}`);
  want(
    dueDatedLoops >= 1,
    `expected ≥ 1 due-dated open loop (the attention feed's input), got ${dueDatedLoops}`,
  );
  want(dormantLoops >= 1, `expected ≥ 1 memory gone quiet (dormant flag), got ${dormantLoops}`);

  return {
    statusCounts,
    memories,
    contradictionRelations,
    replaced,
    openLoops,
    dueDatedLoops,
    dormantLoops,
    documentMemories,
    markoCommitments,
    hardFailures,
    softWarnings,
  };
}

/** Throws with every hard failure when the world did not materialize as designed. */
export function assertEndState(state: DemoEndState): void {
  if (state.hardFailures.length > 0) {
    throw new Error(
      'demo seed end-state assertions FAILED (a silently wrong ' +
        `sandbox is worse than none):\n${state.hardFailures.map((f) => `  ✗ ${f}`).join('\n')}`,
    );
  }
}

export function summarize(state: DemoEndState): string {
  const statuses = Object.entries(state.statusCounts)
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return (
    `memories=${state.memories} [${statuses}] · ` +
    `contradiction-relations=${state.contradictionRelations} · replaced=${state.replaced} · ` +
    `open-loops=${state.openLoops} (due-dated=${state.dueDatedLoops}, quiet=${state.dormantLoops}) · ` +
    `document-memories=${state.documentMemories} · marko-commitments=${state.markoCommitments}`
  );
}
