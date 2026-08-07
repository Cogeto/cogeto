import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, or } from 'drizzle-orm';
import { DRIZZLE } from '../../infrastructure/index';
import type { Db, DbOrTx } from '../../infrastructure/index';
import { checkedPair } from './tables';
import type { CheckedPairRow } from './tables';

/**
 * The judged-pair ledger (V2.3 item 6.1, issue D). Reconciliation asks it
 * BEFORE any model call: a pair already judged under the SAME prompt version
 * and model configuration keeps its verdict — re-asking a sampling process
 * the same question and acting on a different answer is not detection, it is
 * noise. A pair re-opens only when one of its facts changes (supersession
 * mints a new id, so the old pair simply never recurs), when the prompt or
 * model configuration changes (the stored columns disagree with the active
 * ones), or on an explicit re-run (the caller skips the lookup).
 *
 * Storage is canonical (a < b, uuid text order — identical to Postgres uuid
 * byte order for hex text); `direction` is stored relative to that order and
 * mapped back to the caller's.
 */

export type CheckedPairFamily = 'dedup' | 'contradiction';

export interface RecordedVerdict {
  verdict: string;
  /** Relative to the CALLER's (first, second) order. */
  direction: 'a_over_b' | 'b_over_a' | null;
  promptVersion: string;
  modelConfig: string;
  similarity: number | null;
  judgedAt: Date;
}

export interface VerdictToRecord {
  ownerId: string;
  family: CheckedPairFamily;
  verdict: string;
  direction?: 'a_over_b' | 'b_over_a' | null;
  similarity: number | null;
  promptVersion: string;
  modelConfig: string;
  configVersion: number;
}

const canonical = (first: string, second: string): [string, string, boolean] =>
  first < second ? [first, second, false] : [second, first, true];

const flip = (direction: string | null): 'a_over_b' | 'b_over_a' | null =>
  direction === 'a_over_b' ? 'b_over_a' : direction === 'b_over_a' ? 'a_over_b' : null;

@Injectable()
export class CheckedPairStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The standing verdict for (first, second) in `family`, or null when the
   * pair was never judged OR its judgment is stale (prompt or model
   * configuration changed since — a change that could alter the verdict
   * re-opens the pair by construction).
   */
  async currentVerdict(
    tx: DbOrTx,
    first: string,
    second: string,
    family: CheckedPairFamily,
    active: { promptVersion: string; modelConfig: string },
  ): Promise<RecordedVerdict | null> {
    const [a, b, swapped] = canonical(first, second);
    const rows = await tx
      .select()
      .from(checkedPair)
      .where(
        and(
          eq(checkedPair.aMemoryId, a),
          eq(checkedPair.bMemoryId, b),
          eq(checkedPair.family, family),
        ),
      );
    const row = rows[0];
    if (!row) return null;
    if (row.promptVersion !== active.promptVersion || row.modelConfig !== active.modelConfig) {
      return null;
    }
    const direction = (row.direction as 'a_over_b' | 'b_over_a' | null) ?? null;
    return {
      verdict: row.verdict,
      direction: swapped ? flip(direction) : direction,
      promptVersion: row.promptVersion,
      modelConfig: row.modelConfig,
      similarity: row.similarity,
      judgedAt: row.judgedAt,
    };
  }

  /** Upsert the pair's verdict; a re-judgment (fresh prompt or model) replaces. */
  async record(tx: DbOrTx, first: string, second: string, entry: VerdictToRecord): Promise<void> {
    const [a, b, swapped] = canonical(first, second);
    const direction = swapped ? flip(entry.direction ?? null) : (entry.direction ?? null);
    await tx
      .insert(checkedPair)
      .values({
        ownerId: entry.ownerId,
        aMemoryId: a,
        bMemoryId: b,
        family: entry.family,
        verdict: entry.verdict,
        direction,
        similarity: entry.similarity,
        promptVersion: entry.promptVersion,
        modelConfig: entry.modelConfig,
        configVersion: entry.configVersion,
      })
      .onConflictDoUpdate({
        target: [checkedPair.aMemoryId, checkedPair.bMemoryId, checkedPair.family],
        set: {
          verdict: entry.verdict,
          direction,
          similarity: entry.similarity,
          promptVersion: entry.promptVersion,
          modelConfig: entry.modelConfig,
          configVersion: entry.configVersion,
          judgedAt: new Date(),
        },
      });
  }

  /** Ledger rows touching any of `memoryIds` — the near-miss audit read. */
  async forMemories(memoryIds: string[]): Promise<CheckedPairRow[]> {
    if (memoryIds.length === 0) return [];
    return this.db
      .select()
      .from(checkedPair)
      .where(
        or(inArray(checkedPair.aMemoryId, memoryIds), inArray(checkedPair.bMemoryId, memoryIds)),
      );
  }
}
