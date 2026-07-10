import type { Pool } from 'pg';

/**
 * The seed's end-state assertions (decision 0022; §B.9). After the corpus has
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
  tasks: number;
  blockedTasks: number;
  dormantTasks: number;
  documentMemories: number;
  markoCommitments: number;
  hardFailures: string[];
  softWarnings: string[];
}

const MIN_ACTIVE = 8;
const MIN_TASKS = 3;

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
  const tasks = await one('SELECT count(*)::text AS n FROM task WHERE owner_id = $1', [ownerId]);
  const blockedTasks = await one(
    `SELECT count(*)::text AS n FROM task WHERE owner_id = $1 AND status = 'blocked_on_condition'`,
    [ownerId],
  );
  const dormantTasks = await one(
    `SELECT count(*)::text AS n FROM task WHERE owner_id = $1 AND dormant = true`,
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
  need(tasks >= MIN_TASKS, `expected ≥ ${MIN_TASKS} derived tasks, got ${tasks}`);
  need(blockedTasks >= 1, `expected ≥ 1 blocked-on-condition task, got ${blockedTasks}`);
  need(
    documentMemories >= 1,
    `expected ≥ 1 memory derived from the uploaded document, got ${documentMemories}`,
  );
  need(
    markoCommitments >= 1,
    `expected ≥ 1 Marko commitment memory (the "what did Ana promise Marko" answer), got ${markoCommitments}`,
  );

  want(replaced >= 1, `expected a supersession chain (≥1 replaced memory), got ${replaced}`);
  want(dormantTasks >= 1, `expected ≥ 1 dormant task, got ${dormantTasks}`);

  return {
    statusCounts,
    memories,
    contradictionRelations,
    replaced,
    tasks,
    blockedTasks,
    dormantTasks,
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
      'demo seed end-state assertions FAILED (decision 0022 — a silently wrong ' +
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
    `tasks=${state.tasks} (blocked=${state.blockedTasks}, dormant=${state.dormantTasks}) · ` +
    `document-memories=${state.documentMemories} · marko-commitments=${state.markoCommitments}`
  );
}
