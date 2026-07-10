import type { Pool } from 'pg';
import { loadCorpus, loadDocumentBytes } from './corpus';
import type { Corpus } from './corpus';
import type { DemoApi } from './http-client';
import { ageWorld, enqueueDream, waitForQuiescence } from './ops';
import type { AgeEntry } from './ops';
import { assertEndState, inspectEndState, summarize } from './assertions';
import type { DemoEndState } from './assertions';

export type Logger = (message: string) => void;

const noop: Logger = () => undefined;

export interface SeedWorldDeps {
  api: DemoApi;
  pool: Pool;
  ownerId: string;
  corpus?: Corpus;
  /** When true (the init job), a failed assertion throws; false (scheduled
   * reset) logs the failure and continues — the next reset repairs it. */
  strict?: boolean;
  /** Task identifier to exclude from drain counts when seeding from inside the
   * worker (the scheduled reset must not wait for its own running job). */
  excludeTask?: string;
  log?: Logger;
}

/**
 * Feeds the corpus through the public API, ages it to weeks of accrual, runs one
 * dreaming cycle, and asserts the end state (decision 0022, §B.9). The single
 * shared routine behind the init job, the scheduled reset, and the tests — so
 * every path exercises the real pipeline identically.
 */
export async function seedDemoWorld(deps: SeedWorldDeps): Promise<DemoEndState> {
  const log = deps.log ?? noop;
  const corpus = deps.corpus ?? (await loadCorpus());

  log(`seeding ${corpus.notes.length} notes + 1 document through the public API…`);
  const ageEntries = await captureCorpus(deps.api, corpus, log);

  log('draining the ingestion queue…');
  await waitForQuiescence(deps.pool, { excludeTask: deps.excludeTask });

  log('ageing the world to weeks of accrual (back-dating created_at)…');
  await ageWorld(deps.pool, ageEntries);

  log('running one dreaming cycle (consolidation, contradictions, staleness, dormancy)…');
  await enqueueDream(deps.pool);
  await waitForQuiescence(deps.pool, { excludeTask: deps.excludeTask });

  const state = await inspectEndState(deps.pool, deps.ownerId);
  log(`end state: ${summarize(state)}`);
  for (const w of state.softWarnings) log(`  ⚠ ${w}`);

  if (state.hardFailures.length > 0) {
    if (deps.strict !== false) {
      assertEndState(state);
    } else {
      log(`  ✗ end-state assertions did not hold (non-strict reset):`);
      for (const f of state.hardFailures) log(`    ✗ ${f}`);
    }
  } else {
    log('  ✓ all end-state assertions hold');
  }
  return state;
}

/** Fires every corpus item at the public API, returning the aging plan. */
export async function captureCorpus(
  api: DemoApi,
  corpus: Corpus,
  log: Logger = noop,
): Promise<AgeEntry[]> {
  const entries: AgeEntry[] = [];

  for (const note of corpus.notes) {
    if (note.channel === 'note') {
      const { id } = await api.captureNote(note.text);
      await api.waitNote(id);
      entries.push({ sourceType: 'user_note', sourceId: id, daysAgo: note.daysAgo });
      log(`  · note ${note.id} → ${id}`);
    } else {
      const { messageId } = await api.rememberChat(note.text);
      await api.waitChat(messageId);
      entries.push({ sourceType: 'chat', sourceId: messageId, daysAgo: note.daysAgo });
      log(`  · chat ${note.id} → ${messageId}`);
    }
  }

  const bytes = await loadDocumentBytes(corpus.document);
  const { objectKey } = await api.uploadFile(bytes, corpus.document.file, corpus.document.scope);
  await api.waitFile(objectKey);
  entries.push({ sourceType: 'file', sourceId: objectKey, daysAgo: corpus.document.daysAgo });
  log(`  · document ${corpus.document.id} → ${objectKey}`);

  return entries;
}

/** True when the demo owner already has a seeded world (idempotency guard). */
export async function alreadySeeded(pool: Pool, ownerId: string): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM note WHERE owner_id = $1',
    [ownerId],
  );
  return Number(rows[0]?.n ?? '0') > 0;
}
