import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import {
  chooseSurvivor,
  createMemoryStore,
  DeletionSaga,
  MemoryReconciliation,
  supersessionUnambiguous,
} from '../memory/index';
import type { MemoryStore, SourceDeletion } from '../memory/index';
import type { Tx } from '../infrastructure/index';
import { ModelGateway } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import { createSuppressedFactLog } from './persistence/suppressed-fact-log';
import type { SuppressedFactLog } from './persistence/suppressed-fact-log';
import { SuppressedFactCascade } from './suppressed-fact-cascade';
import { createIngestionPipeline } from './pipeline/pipeline.service';
import type { IngestionPipeline } from './pipeline/pipeline.service';
import type { SourceItem, SourceReader } from './pipeline/source-reader';

/**
 * Automatic review resolution and the suppressed-fact log (V2.0 item 3.3).
 *
 * The named tests: admission_no_blocking, uncertain_still_inspectable,
 * log_written_per_decision, log_gated, log_queryable. The deletion cascade has
 * its own file (suppressed-fact-deletion.integration.spec.ts) because it needs
 * the object store too.
 *
 * Real Postgres + real Qdrant; the model is scripted at the gateway seam so each
 * outcome class is produced deliberately rather than hoped for.
 */

const DIMS = 8;

const owner: Principal = {
  userId: 'owner-arr',
  name: 'Owner',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};
const peer: Principal = { ...owner, userId: 'peer-arr', name: 'Peer' };

interface ScriptedFact {
  claim: string;
  span: string;
  hedged?: boolean;
  hedgePhrase?: string;
}

/** One scripted extraction + one scripted verdict rule, keyed by claim text. */
class ScriptedGateway extends ModelGateway {
  constructor(
    private readonly facts: ScriptedFact[],
    /** claim → verdict. A claim absent from the map is omitted from the batch
     * reply entirely, which is how the `unjudgeable` path is produced. */
    private readonly verdicts: Map<string, 'supported' | 'partial' | 'unsupported'>,
  ) {
    super();
  }
  complete(): never {
    throw new Error('not used');
  }
  // eslint-disable-next-line require-yield -- not used
  async *completeStream(): AsyncIterable<string> {
    throw new Error('not used');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => fakeEmbedding(text, DIMS));
  }
  embeddingModelId(): string {
    return 'test-embed';
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    const { input } = request;
    let raw: unknown;
    if (input.startsWith('FACT A:')) {
      raw = request.system.includes('same_fact')
        ? { verdict: 'distinct', reason: 'scripted', merged_content: null }
        : { verdict: 'compatible', direction: null, reason: 'scripted' };
    } else if (input.startsWith('CLAIMS UNDER REVIEW')) {
      const verdicts: unknown[] = [];
      for (const match of input.matchAll(/CLAIM (\d+):\n([^\n]*)/g)) {
        const verdict = this.verdicts.get(match[2]!.trim());
        // No entry → the reply simply omits this claim. The pipeline treats it
        // as unjudged, which is exactly the case being exercised.
        if (verdict) {
          verdicts.push({ claim: Number(match[1]), verdict, reason: `scripted ${verdict}` });
        }
      }
      raw = { verdicts };
    } else if (input.startsWith('CLAIM UNDER REVIEW')) {
      const claim = input.split('\n')[1]!.trim();
      const verdict = this.verdicts.get(claim) ?? 'unsupported';
      raw = { verdict, reason: `scripted ${verdict}` };
    } else {
      raw = {
        facts: this.facts.map((f) => ({
          claim: f.claim,
          kind: 'fact',
          entities: { people: [], organizations: [], projects: [] },
          condition: null,
          temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
          temporal_expressions: [],
          hedged: f.hedged ?? false,
          hedge_phrase: f.hedgePhrase ?? null,
          subject_entity: null,
          source_span: f.span,
        })),
      };
    }
    return schema.parse(raw);
  }
}

/** In-test stage-1 port: the pipeline never touches connector tables. */
class FakeReader implements SourceReader {
  readonly sourceType = 'user_note' as const;
  readonly sources = new Map<string, SourceItem>();

  add(content: string, opts: { ownerId?: string; sensitive?: boolean } = {}): string {
    const sourceId = randomUUID();
    this.sources.set(sourceId, {
      sourceType: this.sourceType,
      sourceId,
      ownerId: opts.ownerId ?? owner.userId,
      content,
      sensitive: opts.sensitive ?? false,
      createdAt: new Date('2026-07-02T10:00:00Z'),
    });
    return sourceId;
  }
  async load(sourceId: string): Promise<SourceItem | null> {
    return this.sources.get(sourceId) ?? null;
  }
  async existsForAdmission(_tx: unknown, sourceId: string): Promise<boolean> {
    return this.sources.has(sourceId);
  }
}

/** The saga's stage-1 mirror: the fake reader's map IS the durable source row. */
class FakeSourceDeletion implements SourceDeletion {
  readonly sourceType = 'user_note' as const;
  constructor(private readonly reader: FakeReader) {}
  async ownerOf(_tx: Tx, sourceId: string): Promise<string | null> {
    return this.reader.sources.get(sourceId)?.ownerId ?? null;
  }
  async deleteSource(_tx: Tx, sourceId: string): Promise<void> {
    this.reader.sources.delete(sourceId);
  }
}

describe('automatic review resolution (integration, real Postgres + Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let log: SuppressedFactLog;
  const reader = new FakeReader();

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: 'test-embed', dimensions: DIMS },
    });
    await store.ensureIndexReady();
    log = createSuppressedFactLog(tdb.db);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const build = (gateway: ModelGateway): IngestionPipeline =>
    createIngestionPipeline({
      readers: [reader],
      gateway,
      store,
      reconciliation: new MemoryReconciliation(tdb.db, store),
      suppressedFacts: createSuppressedFactLog(tdb.db),
    });

  /** The four outcome classes, in one source, produced deliberately. */
  const SOURCE_TEXT = [
    'The workshop is on Tuesday.',
    'Marta may prefer the later slot.',
    'The retainer is 4500 EUR monthly.',
    'The venue holds two hundred people.',
    'The kickoff moved to March.',
  ].join(' ');

  const SUPPORTED = 'The workshop is on Tuesday.';
  const HEDGED = 'Marta may prefer the later slot.';
  const PARTIAL = 'The retainer is 4500 EUR monthly.';
  const UNSUPPORTED = 'The venue holds two hundred people.';
  const OMITTED = 'The kickoff moved to March.';

  const scripted = (): ScriptedGateway =>
    new ScriptedGateway(
      [
        { claim: SUPPORTED, span: 'The workshop is on Tuesday.' },
        {
          claim: HEDGED,
          span: 'Marta may prefer the later slot.',
          hedged: true,
          hedgePhrase: 'may prefer',
        },
        { claim: PARTIAL, span: 'The retainer is 4500 EUR monthly.' },
        { claim: UNSUPPORTED, span: 'The venue holds two hundred people.' },
        { claim: OMITTED, span: 'The kickoff moved to March.' },
        // A structurally invalid extraction: a claim with a blank span. It is
        // withheld BEFORE verification and never reaches the model.
        { claim: 'A claim with no evidence pointer.', span: '   ' },
      ],
      new Map([
        [SUPPORTED, 'supported' as const],
        [HEDGED, 'supported' as const],
        [PARTIAL, 'partial' as const],
        [UNSUPPORTED, 'unsupported' as const],
        // OMITTED is deliberately absent: the batch reply skips it.
      ]),
    );

  const ingest = async (opts: { ownerId?: string; sensitive?: boolean } = {}) => {
    const sourceId = reader.add(SOURCE_TEXT, opts);
    const summary = await tdb.db.transaction((tx) =>
      build(scripted()).run(tx, { source_type: 'user_note', source_id: sourceId }),
    );
    return { sourceId, summary };
  };

  const memoriesFor = async (sourceId: string) => {
    const { rows } = await tdb.pool.query<{
      id: string;
      content: string;
      status: string;
      uncertainty_reason: string | null;
    }>(
      `SELECT id, content, status, uncertainty_reason FROM memory
        WHERE source_type = 'user_note' AND source_id = $1 ORDER BY content`,
      [sourceId],
    );
    return rows;
  };

  // ── admission_no_blocking ───────────────────────────────────────────────────

  it('admission_no_blocking: every outcome class ingests with no human step', async () => {
    const { sourceId, summary } = await ingest();

    // The run completed. Nothing paused, nothing queued, nothing waited.
    expect(summary.skipped).toBeUndefined();
    // Six extracted, one withheld: `extracted` counts what the model produced,
    // `notAdmitted` what the admission line refused. Neither number hides the
    // other.
    expect(summary.extracted).toBe(6);
    expect(summary.notAdmitted).toBe(1);
    expect(summary.admitted.active).toBe(1);
    expect(summary.admitted.uncertain).toBe(4);

    // No approval row exists for any of it: an approval is the only mechanism in
    // this codebase that can hold work for a person, and admission uses none.
    const { rows: approvals } = await tdb.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approval WHERE status = 'pending_approval'`,
    );
    expect(Number(approvals[0]!.n)).toBe(0);

    const memories = await memoriesFor(sourceId);
    expect(memories).toHaveLength(5);
    const byContent = new Map(memories.map((m) => [m.content, m]));

    // Each outcome class landed on its own named arm, and the supported one is
    // active with no reason at all.
    expect(byContent.get(SUPPORTED)).toMatchObject({
      status: 'active',
      uncertainty_reason: null,
    });
    expect(byContent.get(HEDGED)).toMatchObject({
      status: 'uncertain',
      uncertainty_reason: 'hedged_in_source',
    });
    expect(byContent.get(PARTIAL)).toMatchObject({
      status: 'uncertain',
      uncertainty_reason: 'partially_supported',
    });
    expect(byContent.get(UNSUPPORTED)).toMatchObject({
      status: 'uncertain',
      uncertainty_reason: 'unsupported',
    });
    expect(byContent.get(OMITTED)).toMatchObject({
      status: 'uncertain',
      uncertainty_reason: 'unjudgeable',
    });

    // The withheld one is not a memory. It is not lost either: see log_written.
    expect(byContent.has('A claim with no evidence pointer.')).toBe(false);
  });

  // ── uncertain_still_inspectable ─────────────────────────────────────────────

  it('uncertain_still_inspectable: an uncertain fact is retrievable, visible and demoted, never discarded', async () => {
    const { sourceId } = await ingest();
    const memories = await memoriesFor(sourceId);
    const uncertain = memories.find((m) => m.content === UNSUPPORTED)!;

    // Visible through the gated read path the dashboard and Sources use.
    const read = await store.getForPrincipal(owner, uncertain.id, { includeSensitive: true });
    expect(read?.content).toBe(UNSUPPORTED);
    expect(read?.status).toBe('uncertain');
    expect(read?.uncertaintyReason).toBe('unsupported');

    // Listed, and countable, exactly as before the taxonomy.
    const listed = await store.listForPrincipal(owner, { status: 'uncertain', mine: true });
    expect(listed.map((r) => r.id)).toContain(uncertain.id);

    // Retrievable: the row carries its embedding model, so the point exists and
    // the fact can still be cited. Demotion is a score multiplier, never a gate.
    expect(read?.embeddingModel).toBe('test-embed');

    // And it is explained rather than merely demoted.
    const explained = await log.list(owner, { sourceId, reason: 'unsupported' });
    expect(explained.items).toHaveLength(1);
    expect(explained.items[0]!.memoryId).toBe(uncertain.id);
  });

  // ── log_written_per_decision ────────────────────────────────────────────────

  it('log_written_per_decision: one entry per automatic decision, with the right fields and span', async () => {
    const { sourceId } = await ingest();
    const entries = await log.forSource(tdb.db, 'user_note', sourceId);

    // Five decisions: four demotions plus one non-admission. The supported fact
    // was admitted plainly and writes nothing: the log records decisions that
    // demoted or withheld, not every fact.
    expect(entries).toHaveLength(5);
    expect(entries.filter((e) => e.factContent === SUPPORTED)).toHaveLength(0);

    const byContent = new Map(entries.map((e) => [e.factContent, e]));

    // The hedged one: reason, span, and the verifier's own supporting verdict.
    const hedged = byContent.get(HEDGED)!;
    expect(hedged.reason).toBe('hedged_in_source');
    expect(hedged.sourceSpan).toBe('Marta may prefer the later slot.');
    expect(hedged.verificationVerdict).toBe('supported');
    expect(hedged.verificationReason).toBe('scripted supported');
    expect(hedged.promptVersion).toMatch(/^verification\//);
    expect(hedged.memoryId).not.toBeNull();

    expect(byContent.get(PARTIAL)!.reason).toBe('partially_supported');
    expect(byContent.get(PARTIAL)!.verificationVerdict).toBe('partial');
    expect(byContent.get(UNSUPPORTED)!.reason).toBe('unsupported');
    expect(byContent.get(OMITTED)!.reason).toBe('unjudgeable');

    // The withheld fact: recorded in full, with memory_id NULL. That null IS the
    // record that it was not admitted, and the entry is why it is still
    // recoverable and explainable rather than silently gone.
    const withheld = byContent.get('A claim with no evidence pointer.')!;
    expect(withheld.reason).toBe('structurally_invalid');
    expect(withheld.memoryId).toBeNull();
    // No verification ran, so no verdict is invented for it.
    expect(withheld.verificationVerdict).toBeNull();
    expect(withheld.verificationReason).toBeNull();

    // Owner and scope are inherited from the source, every entry.
    for (const entry of entries) {
      expect(entry.ownerId).toBe(owner.userId);
      expect(entry.scope).toBe('private');
      expect(entry.sensitive).toBe(false);
      expect(entry.sourceType).toBe('user_note');
      expect(entry.sourceId).toBe(sourceId);
      // Every entry names the span it came from, VERBATIM — including the blank
      // one, whose blankness is precisely the reason it was withheld.
      if (entry.reason === 'structurally_invalid') {
        expect(entry.sourceSpan).toBe('   ');
      } else {
        expect(entry.sourceSpan.trim().length).toBeGreaterThan(0);
      }
    }
  });

  // ── log_gated ───────────────────────────────────────────────────────────────

  it('log_gated: a peer never reads entries for a source they cannot see; sensitive is respected', async () => {
    const { sourceId } = await ingest();

    // Private source: invisible to a peer, in the list AND in the summary.
    expect((await log.list(peer, { sourceId })).items).toHaveLength(0);
    expect((await log.summarize(peer, { sourceId })).total).toBe(0);
    expect((await log.list(owner, { sourceId })).items.length).toBeGreaterThan(0);

    // A sensitive source's entries are owner-only even when shared-scoped: the
    // sensitive rule on the log is the sensitive rule on memories.
    const sensitiveId = reader.add(SOURCE_TEXT, { sensitive: true });
    await tdb.db.transaction((tx) =>
      build(scripted()).run(tx, { source_type: 'user_note', source_id: sensitiveId }),
    );
    await tdb.pool.query(`UPDATE suppressed_fact_log SET scope = 'shared' WHERE source_id = $1`, [
      sensitiveId,
    ]);
    expect((await log.list(peer, { sourceId: sensitiveId })).items).toHaveLength(0);
    expect((await log.list(owner, { sourceId: sensitiveId })).items.length).toBeGreaterThan(0);

    // A shared, non-sensitive source IS readable by a peer — the gate is the
    // memory gate, not a blanket owner-only rule.
    await tdb.pool.query(
      `UPDATE suppressed_fact_log SET scope = 'shared', sensitive = false WHERE source_id = $1`,
      [sensitiveId],
    );
    expect((await log.list(peer, { sourceId: sensitiveId })).items.length).toBeGreaterThan(0);
  });

  // ── log_queryable ───────────────────────────────────────────────────────────

  it('log_queryable: by source, by reason and by date range, with correct counts', async () => {
    const { sourceId } = await ingest();

    // By source.
    const bySource = await log.list(owner, { sourceId });
    expect(bySource.total).toBe(5);
    expect(bySource.items).toHaveLength(5);

    // By reason.
    for (const [reason, expected] of [
      ['hedged_in_source', 1],
      ['partially_supported', 1],
      ['unsupported', 1],
      ['unjudgeable', 1],
      ['structurally_invalid', 1],
      ['legacy_unspecified', 0],
    ] as const) {
      const page = await log.list(owner, { sourceId, reason });
      expect(page.total, reason).toBe(expected);
    }

    // The summary is the same gate and the same filters, as counts — and it
    // reports every reason in the vocabulary, zeros included, so the report has
    // a stable shape to render.
    const summary = await log.summarize(owner, { sourceId });
    expect(summary.total).toBe(5);
    expect(summary.byReason).toEqual({
      hedged_in_source: 1,
      partially_supported: 1,
      unsupported: 1,
      unjudgeable: 1,
      structurally_invalid: 1,
      legacy_unspecified: 0,
    });

    // By date range: a window before the decisions is empty, one around them
    // holds all five.
    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 86_400_000);
    expect((await log.list(owner, { sourceId, to: past })).total).toBe(0);
    expect((await log.list(owner, { sourceId, from: future })).total).toBe(0);
    expect((await log.list(owner, { sourceId, from: past, to: future })).total).toBe(5);

    // Paging is bounded and the total counts everything under the filters.
    const paged = await log.list(owner, { sourceId, limit: 2 });
    expect(paged.items).toHaveLength(2);
    expect(paged.total).toBe(5);
  });

  // ── contextual_confirm_promotes ─────────────────────────────────────────────

  it('contextual_confirm_promotes: confirming an uncertain fact yields user_approved, audited, and reconciliation still respects it', async () => {
    const { sourceId } = await ingest();
    const target = (await memoriesFor(sourceId)).find((m) => m.content === UNSUPPORTED)!;
    expect(target.status).toBe('uncertain');

    // The confirmation path is the one the drawer calls — no queue involved.
    const confirmed = await store.transition(
      { kind: 'user', userId: owner.userId },
      target.id,
      'user_approved',
      'confirmed from the memory drawer',
    );
    expect(confirmed.status).toBe('user_approved');

    // Audited, exactly as before.
    const { rows: audit } = await tdb.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE action = 'memory.status_transition' AND entity_id = $1 AND actor = $2`,
      [target.id, `user:${owner.userId}`],
    );
    expect(Number(audit[0]!.n)).toBe(1);

    // The admission record survives the promotion: it says why the fact WAS
    // admitted uncertain, which stays true and is what the findings report
    // renders. The status says what the user decided about it since.
    const after = await store.getForPrincipal(owner, target.id, { includeSensitive: true });
    expect(after?.uncertaintyReason).toBe('unsupported');

    // And the shield still holds: user judgment outranks machine judgment.
    const party = (id: string, status: 'user_approved' | 'active', day: string) => ({
      id,
      status: status as never,
      createdAt: new Date(day),
      validFrom: null,
      validUntil: null,
    });
    const older = party(target.id, 'user_approved', '2026-07-01');
    const newer = party('other', 'active', '2026-07-03');
    expect(chooseSurvivor(older, newer)).toMatchObject({ action: 'merge', survivor: older });
    expect(supersessionUnambiguous(newer, older)).toBe(false);
  });

  it('contextual_confirm_promotes: rejecting an extraction takes its log entry with it', async () => {
    // Rejection is the one memory hard-delete outside the saga. The entry holds
    // the rejected extraction's content and span, so it must not outlive the row
    // the user removed: `memory_id` FKs with ON DELETE CASCADE, and the NULL it
    // would otherwise be set to means something else entirely (never admitted).
    const { sourceId } = await ingest();
    const target = (await memoriesFor(sourceId)).find((m) => m.content === PARTIAL)!;
    expect(await log.list(owner, { sourceId, reason: 'partially_supported' })).toMatchObject({
      total: 1,
    });

    await store.rejectUncertain(owner, target.id);

    expect((await log.list(owner, { sourceId, reason: 'partially_supported' })).total).toBe(0);
    // The other entries are untouched: rejection is per-fact, not per-source.
    expect((await log.list(owner, { sourceId })).total).toBe(4);
  });

  // ── log_deletion_cascade ────────────────────────────────────────────────────

  it('log_deletion_cascade: deleting a source removes its entries and the receipt counts them', async () => {
    const { sourceId } = await ingest();
    expect(await log.forSource(tdb.db, 'user_note', sourceId)).toHaveLength(5);

    // The saga with the cascade bound exactly as the composition roots bind it:
    // memory owns the port, ingestion owns the table, neither reaches into the
    // other.
    const saga = new DeletionSaga(tdb.db, [new FakeSourceDeletion(reader)], undefined, [
      new SuppressedFactCascade(createSuppressedFactLog(tdb.db)),
    ]);

    const { receiptId } = await saga.requestSourceDeletion(owner, 'user_note', sourceId);
    expect(receiptId).not.toBeNull();

    // Gone: BOTH halves. The four admitted entries went with their memories and
    // the withheld one, which has no memory row at all, went with its source.
    // A content-bearing table the saga cannot reach would be a regression
    // against the erasure promise, so this assertion is the whole point.
    expect(await log.forSource(tdb.db, 'user_note', sourceId)).toHaveLength(0);

    // And the receipt says so: the erasure claim counts what was erased.
    const { rows } = await tdb.pool.query<{ counts_json: Record<string, unknown> }>(
      'SELECT counts_json FROM deletion_receipt WHERE id = $1',
      [receiptId],
    );
    expect(rows[0]!.counts_json['suppressed_facts_removed']).toBe(5);
    expect(rows[0]!.counts_json['memory_count']).toBe(5);
  });
});
