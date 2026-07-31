import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';

/**
 * backfill_correct (V2.0 item 3.3, migration 0039).
 *
 * Existing `uncertain` rows predate the taxonomy, so they carry no sub-reason.
 * The migration derives one where the stored verification result determines it,
 * and marks the rest `legacy_unspecified` rather than guessing. Guessing is the
 * failure mode that matters here: the V2.3 findings report renders these values,
 * and a fabricated reason would be a fabricated finding.
 *
 * The test runs the SHIPPED backfill SQL, read out of the migration file, over
 * rows inserted the way the pre-taxonomy pipeline wrote them (raw SQL, since the
 * aggregate now refuses an uncertain admission with no reason). A copy of the
 * SQL in the test would be a test of the copy.
 */

/** The backfill half of migration 0039: everything from the marker onward. */
async function backfillStatements(): Promise<string[]> {
  const file = path.resolve(__dirname, '..', 'migrations', '0039_auto_review_resolution.sql');
  const sql = await readFile(file, 'utf8');
  const marker = '-- Backfill, most specific first.';
  const at = sql.indexOf(marker);
  expect(at, 'the backfill section marker moved; update this test with it').toBeGreaterThan(0);
  return sql
    .slice(at)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.split('\n').every((line) => line.trim().startsWith('--')));
}

describe('uncertainty backfill (integration, real Postgres)', () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await startTestDatabase();
  }, 120_000);
  afterAll(async () => {
    await tdb.stop();
  });

  /** A pre-taxonomy row: uncertain, no sub-reason, written past the aggregate. */
  const seedLegacy = async (opts: {
    content: string;
    status?: string;
    verification?: { verdict: 'supported' | 'partial' | 'unsupported'; hedgePhrase?: string };
  }): Promise<string> => {
    const { rows } = await tdb.pool.query<{ id: string }>(
      `INSERT INTO memory (owner_id, scope, source_type, source_id, status, content)
       VALUES ($1, 'private', 'user_note', $2, $3, $4) RETURNING id`,
      ['backfill-owner', randomUUID(), opts.status ?? 'uncertain', opts.content],
    );
    const id = rows[0]!.id;
    if (opts.verification) {
      await tdb.pool.query(
        `INSERT INTO verification_result (memory_id, verdict, reason, prompt_version, source_span, hedge_phrase)
         VALUES ($1, $2, 'legacy row', 'verification/v0004', 'a span', $3)`,
        [id, opts.verification.verdict, opts.verification.hedgePhrase ?? null],
      );
    }
    return id;
  };

  it('backfill_correct: derivable rows get their sub-reason, the rest get the legacy value', async () => {
    // Every shape a pre-taxonomy database can hold.
    const hedged = await seedLegacy({
      content: 'legacy hedged',
      verification: { verdict: 'supported', hedgePhrase: 'may prefer' },
    });
    const partial = await seedLegacy({
      content: 'legacy partial',
      verification: { verdict: 'partial' },
    });
    const unsupported = await seedLegacy({
      content: 'legacy unsupported',
      verification: { verdict: 'unsupported' },
    });
    // Not derivable: supported with no recorded hedge phrase (a pre-hedge-column
    // row). The reason genuinely cannot be recovered, so it must not be invented.
    const supportedNoHedge = await seedLegacy({
      content: 'legacy supported, no hedge phrase',
      verification: { verdict: 'supported' },
    });
    // Not derivable: no verification result at all.
    const noVerification = await seedLegacy({ content: 'legacy with no verification' });
    // A row that was never uncertain must be left entirely alone.
    const active = await seedLegacy({
      content: 'an active row',
      status: 'active',
      verification: { verdict: 'supported' },
    });

    // The column starts empty for all of them: this IS the pre-migration state.
    const reasonOf = async (id: string): Promise<string | null> => {
      const { rows } = await tdb.pool.query<{ uncertainty_reason: string | null }>(
        'SELECT uncertainty_reason FROM memory WHERE id = $1',
        [id],
      );
      return rows[0]!.uncertainty_reason;
    };
    await tdb.pool.query('UPDATE memory SET uncertainty_reason = NULL WHERE owner_id = $1', [
      'backfill-owner',
    ]);
    expect(await reasonOf(hedged)).toBeNull();

    // Run the shipped backfill.
    for (const statement of await backfillStatements()) {
      await tdb.pool.query(statement);
    }

    // Derivable → derived, most specific first. A hedged row is `hedged_in_source`
    // even though its verdict is `supported`, because the hedge phrase is the
    // recorded, unambiguous evidence of the source's own tentativeness.
    expect(await reasonOf(hedged)).toBe('hedged_in_source');
    expect(await reasonOf(partial)).toBe('partially_supported');
    expect(await reasonOf(unsupported)).toBe('unsupported');

    // Not derivable → explicitly legacy, never guessed.
    expect(await reasonOf(supportedNoHedge)).toBe('legacy_unspecified');
    expect(await reasonOf(noVerification)).toBe('legacy_unspecified');

    // Never uncertain → untouched.
    expect(await reasonOf(active)).toBeNull();

    // No uncertain row is left without a reason: the backfill is total, exactly
    // as the runtime mapping is.
    const { rows } = await tdb.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM memory
        WHERE status = 'uncertain' AND uncertainty_reason IS NULL`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('backfill_correct: re-running it changes nothing (each row is written once)', async () => {
    const statements = await backfillStatements();
    const before = await tdb.pool.query('SELECT id, uncertainty_reason FROM memory ORDER BY id');
    for (const statement of statements) await tdb.pool.query(statement);
    const after = await tdb.pool.query('SELECT id, uncertainty_reason FROM memory ORDER BY id');
    expect(after.rows).toEqual(before.rows);
  });
});
