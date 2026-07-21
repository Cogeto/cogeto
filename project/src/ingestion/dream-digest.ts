import { eq, gte } from 'drizzle-orm';
import type { DreamDigestDto, DreamDigestLine, Principal } from '@cogeto/shared';
import type { Db } from '../infrastructure/index';
import { MemoryStore } from '../memory/index';
import type { MemoryRow } from '../memory/index';
import { dreamAction, dreamRun } from './persistence/tables';
import type { DreamActionRow, DreamPass } from './persistence/tables';
import { latestFinishedRun } from './dreaming.service';
import type { DigestTaskSectionPort } from './digest-task-port';

/**
 * The dreaming digest, assembled from the latest finished run (§B.6 v1 form;
 * decision 0011). Extracted from DreamingController so BOTH the digest endpoint
 * and the attention feed (Post-v1 Priority 2) build the same lines from one
 * place — never a second, drifting digest.
 *
 * Owner scoping falls out of the gates: memory details resolve ONLY through the
 * caller's gated reads, so an action on another owner's memory (or on one
 * deleted since) simply produces no line. dream_run/dream_action are
 * ingestion's own tables; the memory table is never joined.
 */

/** Lines the panel shows before folding the rest into one overflow line. */
const MAX_LINES = 6;

export async function buildDreamDigest(
  db: Db,
  memoryStore: MemoryStore,
  principal: Principal,
  opts: { taskSection?: DigestTaskSectionPort | null } = {},
): Promise<DreamDigestDto> {
  const run = await latestFinishedRun(db);
  // The consolidation section: the latest finished run's actions (empty when
  // there is no run yet). Capped and folded by buildLines.
  let dreamingLines: DreamDigestLine[] = [];
  if (run) {
    const actions = await db.select().from(dreamAction).where(eq(dreamAction.runId, run.id));
    dreamingLines = (await buildDigestLines(memoryStore, principal, actions)).map((l) => ({
      ...l,
      section: 'consolidation' as const,
    }));
  }
  // The tasks section: reminders + updates, independent of whether a dream run
  // exists (a due task must surface even on a store that never dreamt).
  const taskLines =
    (await opts.taskSection?.taskLines(principal, { scopeFrom: run?.scopeFrom ?? null })) ?? [];
  return {
    runId: run?.id ?? null,
    finishedAt: run?.finishedAt?.toISOString() ?? null,
    // Silence on empty (F2 §2 / F3 §3): an empty run AND an empty task set
    // render no panel — the frontend hides on `lines.length === 0`.
    lines: [...dreamingLines, ...taskLines],
  };
}

/**
 * The consolidation lines for a run's actions, gated and ordered. Deterministic
 * given the action set — the attention feed keys its dismissible digest items
 * on the line's position in this order (`digest:<runId>:<index>`), so the key
 * carries no memory content.
 */
export async function buildDigestLines(
  memoryStore: MemoryStore,
  principal: Principal,
  actions: DreamActionRow[],
): Promise<DreamDigestLine[]> {
  if (actions.length === 0) return [];
  const ids = [...new Set(actions.map((a) => a.memoryId))];
  const rows = await memoryStore.getManyForPrincipal(principal, ids, { includeSensitive: true });
  const visible = new Map(rows.map((row) => [row.id, row]));

  // Priority: conflicts first (they want attention), then merges and updates
  // (the work done), then quiet commitments, then the aggregate.
  const lines: DreamDigestLine[] = [];
  const byPass = (pass: DreamActionRow['pass']) =>
    actions.filter((a) => a.pass === pass && visible.has(a.memoryId));

  for (const action of byPass('contradiction')) {
    lines.push({
      text: `Found a conflict about ${label(visible.get(action.memoryId)!)} — your call`,
      href: '/review?tab=contradicted',
    });
  }
  for (const action of byPass('dedup')) {
    lines.push({
      text: `Merged two notes about ${label(visible.get(action.memoryId)!)}`,
      href: `/memories?open=${action.memoryId}`,
    });
  }
  for (const action of byPass('supersession')) {
    lines.push({
      text: `Updated ${label(visible.get(action.memoryId)!)} — a newer fact replaced an older one`,
      href: `/memories?open=${action.memoryId}`,
    });
  }
  for (const action of byPass('dormant')) {
    lines.push({
      text: `A commitment about ${label(visible.get(action.memoryId)!)} has gone quiet`,
      href: `/memories?open=${action.memoryId}`,
    });
  }
  const outdated = byPass('staleness');
  if (outdated.length > 0) {
    lines.push({
      text:
        outdated.length === 1
          ? `Marked 1 memory outdated — its date passed`
          : `Marked ${outdated.length} memories outdated — their dates passed`,
      href: '/memories?status=outdated',
    });
  }

  if (lines.length > MAX_LINES) {
    const shown = lines.slice(0, MAX_LINES - 1);
    shown.push({
      text: `…and ${lines.length - (MAX_LINES - 1)} more changes`,
      href: '/memories',
    });
    return shown;
  }
  return lines;
}

/**
 * Dreaming consolidation activity per UTC day over a BOUNDED window — the
 * dashboard's "dreaming activity over time" series (merges, conflicts caught).
 * Gated: only actions on memories the caller can read are counted, so a
 * stranger sees nothing. Bounded by the run window; the per-action visibility
 * gate is applied in memory (never a cross-module SQL join).
 */
export async function dreamingActivityForPrincipal(
  db: Db,
  memoryStore: MemoryStore,
  principal: Principal,
  days: number,
): Promise<Array<{ day: string; pass: DreamPass; count: number }>> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({
      pass: dreamAction.pass,
      memoryId: dreamAction.memoryId,
      startedAt: dreamRun.startedAt,
    })
    .from(dreamAction)
    .innerJoin(dreamRun, eq(dreamAction.runId, dreamRun.id))
    .where(gte(dreamRun.startedAt, since));
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.memoryId))];
  const visible = new Set(
    (await memoryStore.getManyForPrincipal(principal, ids, { includeSensitive: true })).map(
      (m) => m.id,
    ),
  );
  const bucket = new Map<string, number>();
  for (const r of rows) {
    if (!visible.has(r.memoryId)) continue;
    const day = r.startedAt.toISOString().slice(0, 10);
    const key = `${day}|${r.pass}`;
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }
  return [...bucket.entries()].map(([k, count]) => {
    const [day, pass] = k.split('|') as [string, DreamPass];
    return { day, pass, count };
  });
}

/** A short human handle for a memory: its subject, first entity, or content. */
function label(row: MemoryRow): string {
  if (row.subjectEntity) return row.subjectEntity;
  if (row.entities.length > 0) return row.entities[0]!;
  const content = (row.content ?? '').trim();
  return content.length > 40 ? `“${content.slice(0, 37)}…”` : `“${content}”`;
}
