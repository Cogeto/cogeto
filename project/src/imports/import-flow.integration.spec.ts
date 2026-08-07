import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import type { MemoryObjectStore, MemoryReconciliation, MemoryStore } from '../memory/index';
import {
  INGESTION_PIPELINE_JOB_TYPE,
  SourceContextStore,
  SourceRevisionStore,
} from '../ingestion/index';
import type { FilesService, LadderedDocumentReader } from '../files/index';
import { ImportService } from './import.service';
import { ImportCoordinator } from './import-coordinator';
import { importItem, importRun } from './persistence/tables';

/**
 * The import flow (V2.2 item 5.3): manifest classification keeps the two
 * hash cases distinct, the coordinator's pass is resumable rows-only state,
 * the daily cap PAUSES rather than bypasses, cancellation reports honest
 * numbers, and the revision linker records auto/proposed/nothing per
 * docs/features/revisions.md — with rejected pairs never re-proposed and
 * manual links overriding. The live pipeline end of this (facts, reconcile,
 * supersession) is exercised in the compose walk; here every collaborator
 * that would call a model is scripted.
 */

const OWNER = 'user-import';
const ORG = 'org-import';

const principal: Principal = {
  userId: OWNER,
  name: 'Import Tester',
  email: null,
  orgId: ORG,
  orgName: '',
  roles: [],
};

/** In-memory object store standing in for MinIO. */
class FakeObjectStore {
  store = new Map<
    string,
    { body: Buffer; contentType: string; metadata: Record<string, string> }
  >();

  async putObject(
    key: string,
    body: Buffer,
    options: { contentType?: string; metadata?: Record<string, string> } = {},
  ): Promise<void> {
    this.store.set(key, {
      body,
      contentType: options.contentType ?? 'application/octet-stream',
      metadata: options.metadata ?? {},
    });
  }

  async getObject(key: string) {
    const object = this.store.get(key);
    if (!object) throw new Error(`no such object: ${key}`);
    return { body: object.body, contentType: object.contentType, metadata: object.metadata };
  }

  async statObject(key: string) {
    const object = this.store.get(key);
    if (!object) throw new Error(`no such object: ${key}`);
    return {
      sizeBytes: object.body.length,
      contentType: object.contentType,
      metadata: object.metadata,
    };
  }

  async deleteObject(key: string): Promise<void> {
    this.store.delete(key);
  }

  async listObjects(): Promise<{ key: string; lastModified: Date; sizeBytes: number | null }[]> {
    return [];
  }
}

/** The upload seam: succeeds with a minted key, or throws what it is told. */
class FakeFiles {
  uploads: string[] = [];
  failWith: { status: number } | null = null;
  private counter = 0;

  async upload(_principal: Principal, file: { originalName: string }) {
    if (this.failWith) {
      const status = this.failWith.status;
      throw Object.assign(new Error(`upload refused ${status}`), { getStatus: () => status });
    }
    this.counter += 1;
    const objectKey = `${ORG}/${OWNER}/files/uploaded-${this.counter}`;
    this.uploads.push(file.originalName);
    return { objectKey };
  }
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('import flow', () => {
  let tdb: TestDatabase;
  let objects: FakeObjectStore;
  let files: FakeFiles;
  let service: ImportService;
  let coordinator: ImportCoordinator;
  let revisions: SourceRevisionStore;
  let readerTexts: Map<string, string>;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    objects = new FakeObjectStore();
    files = new FakeFiles();
    revisions = new SourceRevisionStore(tdb.db);
    readerTexts = new Map();
    service = new ImportService(tdb.db, objects as unknown as MemoryObjectStore);
    const memory = {
      sourceFactStatsForRefs: async () => new Map<string, { facts: number; superseded: number }>(),
    } as unknown as MemoryStore;
    const reconciliation = {
      openContradictionCountsForSources: async () => new Map<string, number>(),
    } as unknown as MemoryReconciliation;
    const reader = {
      read: async (_owner: string, body: Buffer) => ({
        text: readerTexts.get(body.toString('utf8')) ?? body.toString('utf8'),
      }),
    } as unknown as LadderedDocumentReader;
    coordinator = new ImportCoordinator(
      tdb.db,
      files as unknown as FilesService,
      objects as unknown as MemoryObjectStore,
      memory,
      reconciliation,
      new SourceContextStore(tdb.db),
      revisions,
      reader,
      1,
    );

    // The corpus this import lands next to: one stored upload, filename on
    // the object (never a column), checksum on the metadata row. Seeded in
    // raw SQL: a spec may not import another module's table definitions.
    await tdb.db.execute(sql`
      INSERT INTO file_metadata (object_key, owner_id, scope, checksum)
      VALUES (${`${ORG}/${OWNER}/files/prev-policy`}, ${OWNER}, 'private',
              ${sha('the original policy text')})
    `);
    await objects.putObject(
      `${ORG}/${OWNER}/files/prev-policy`,
      Buffer.from('the original policy text'),
      { metadata: { 'original-filename': encodeURIComponent('Policy.pdf') } },
    );
  });

  afterAll(async () => {
    await tdb.stop();
  });

  // ── Manifest classification: the two hash cases stay distinct ────────────

  it('identical content is a DUPLICATE, same name with different content a revision candidate', async () => {
    const detail = await service.createFolderManifest(principal, {
      items: [
        { name: 'archive/Policy.pdf', sizeBytes: 24, contentHash: sha('the original policy text') },
        { name: 'Policy.pdf', sizeBytes: 20, contentHash: sha('the corrected policy') },
        { name: 'notes.exe', sizeBytes: 10, contentHash: sha('whatever') },
      ],
    });
    const byName = new Map(detail.items.map((item) => [item.name, item]));
    // Same hash: duplicate, skipped, counted — even from another folder.
    expect(byName.get('archive/Policy.pdf')).toMatchObject({
      state: 'duplicate',
      reason: 'content_hash_match',
    });
    // Same normalized filename, different hash: ingested normally, NOMINATED.
    expect(byName.get('Policy.pdf')).toMatchObject({
      state: 'listed',
      revisionOf: `${ORG}/${OWNER}/files/prev-policy`,
    });
    // Unsupported extensions are labelled honestly in the manifest.
    expect(byName.get('notes.exe')).toMatchObject({
      state: 'unsupported',
      reason: 'unsupported_type',
    });
    expect(detail.progress.duplicates).toBe(1);
  });

  // ── The coordinator's pass: top-up, reap, resume, pause, cancel ──────────

  async function runningRun(names: string[]): Promise<{ runId: string; itemIds: string[] }> {
    const [run] = await tdb.db
      .insert(importRun)
      .values({ ownerId: OWNER, orgId: ORG, kind: 'folder', state: 'running' })
      .returning();
    const itemIds: string[] = [];
    for (const name of names) {
      const [item] = await tdb.db
        .insert(importItem)
        .values({ runId: run!.id, ownerId: OWNER, name, contentHash: sha(name) })
        .returning();
      const stagingKey = `${ORG}/${OWNER}/staging/import-${run!.id}-${item!.id}`;
      await objects.putObject(stagingKey, Buffer.from(`content of ${name}`), {
        metadata: { 'original-filename': encodeURIComponent(name) },
      });
      await tdb.db.update(importItem).set({ stagingKey }).where(eq(importItem.id, item!.id));
      itemIds.push(item!.id);
    }
    return { runId: run!.id, itemIds };
  }

  const itemStates = async (runId: string) => {
    const rows = await tdb.db
      .select()
      .from(importItem)
      .where(eq(importItem.runId, runId))
      .orderBy(importItem.name);
    return rows;
  };

  const settlePipeline = async (objectKey: string, outcome: 'done' | 'failed') => {
    if (outcome === 'done') {
      await tdb.db.execute(sql`
        INSERT INTO job_execution (source_type, source_id, job_type)
        VALUES ('file', ${objectKey}, ${INGESTION_PIPELINE_JOB_TYPE})
      `);
    } else {
      await tdb.db.execute(sql`
        INSERT INTO dead_letter (job_type, payload, error, attempts)
        VALUES (${INGESTION_PIPELINE_JOB_TYPE},
                ${JSON.stringify({ source_type: 'file', source_id: objectKey })}::jsonb,
                'scripted failure', 10)
      `);
    }
  };

  it('tops up to the in-flight cap, reaps settled work, and RESUMES from rows alone', async () => {
    const { runId } = await runningRun(['a.pdf', 'b.pdf']);

    await coordinator.advance(runId);
    let rows = await itemStates(runId);
    // Cap 1: exactly one item entered the pipeline; its staging twin is gone.
    expect(rows.filter((row) => row.state === 'queued')).toHaveLength(1);
    expect(rows.filter((row) => row.state === 'listed')).toHaveLength(1);
    const first = rows.find((row) => row.state === 'queued')!;
    expect(first.objectKey).toBeTruthy();
    expect(first.stagingKey).toBeNull();
    expect(objects.store.has(`${ORG}/${OWNER}/staging/import-${runId}-${first.id}`)).toBe(false);

    // A re-run (the restart) with nothing settled changes nothing: state is rows.
    await coordinator.advance(runId);
    rows = await itemStates(runId);
    expect(rows.filter((row) => row.state === 'queued')).toHaveLength(1);
    expect(files.uploads).toHaveLength(1);

    // The pipeline settles; the next pass reaps and tops up the second item.
    await settlePipeline(first.objectKey!, 'done');
    await coordinator.advance(runId);
    rows = await itemStates(runId);
    expect(rows.find((row) => row.id === first.id)!.state).toBe('ingested');
    const second = rows.find((row) => row.state === 'queued')!;
    expect(second).toBeTruthy();

    // A pipeline FAILURE fails that file alone, with its reason.
    await settlePipeline(second.objectKey!, 'failed');
    await coordinator.advance(runId);
    rows = await itemStates(runId);
    expect(rows.find((row) => row.id === second.id)).toMatchObject({
      state: 'failed',
      reason: 'pipeline_failed',
    });

    // Everything settled: the run finalizes with real numbers.
    const [run] = await tdb.db.select().from(importRun).where(eq(importRun.id, runId));
    expect(run!.state).toBe('completed');
    expect(run!.countsJson).toMatchObject({ documents: 1, failed: 1 });
  });

  it('the daily upload cap PAUSES the import visibly, and it resumes after', async () => {
    const { runId } = await runningRun(['capped.pdf']);
    files.failWith = { status: 429 };
    await coordinator.advance(runId);
    let rows = await itemStates(runId);
    // Nothing bypassed, nothing failed: the item is still waiting.
    expect(rows[0]!.state).toBe('listed');
    const [paused] = await tdb.db.select().from(importRun).where(eq(importRun.id, runId));
    expect(paused!.optionsJson?.pausedReason).toBe('daily_upload_limit');

    files.failWith = null;
    await coordinator.advance(runId);
    rows = await itemStates(runId);
    expect(rows[0]!.state).toBe('queued');
    const [resumed] = await tdb.db.select().from(importRun).where(eq(importRun.id, runId));
    expect(resumed!.optionsJson?.pausedReason ?? null).toBeNull();
  });

  it('a validation refusal fails that file alone', async () => {
    const { runId } = await runningRun(['rejected.pdf']);
    files.failWith = { status: 400 };
    await coordinator.advance(runId);
    files.failWith = null;
    const rows = await itemStates(runId);
    expect(rows[0]).toMatchObject({ state: 'failed', reason: 'rejected_at_upload' });
  });

  it('cancellation keeps what was ingested, reports honest counts, and cleans staging', async () => {
    const { runId } = await runningRun(['keep.pdf', 'never-started.pdf']);
    await coordinator.advance(runId);
    const inFlight = (await itemStates(runId)).find((row) => row.state === 'queued')!;
    await settlePipeline(inFlight.objectKey!, 'done');

    await service.cancel(principal, runId);
    await coordinator.advance(runId);

    const rows = await itemStates(runId);
    expect(rows.find((row) => row.id === inFlight.id)!.state).toBe('ingested');
    expect(rows.filter((row) => row.state === 'cancelled')).toHaveLength(1);
    for (const row of rows) expect(row.stagingKey).toBeNull();
    const [run] = await tdb.db.select().from(importRun).where(eq(importRun.id, runId));
    expect(run!.state).toBe('cancelled');
    expect(run!.countsJson).toMatchObject({ documents: 1, cancelled: 1 });
  });

  // ── Revision linking: docs/features/revisions.md, end to end over rows ───

  async function settledCandidate(options: {
    name: string;
    successorContext?: { subjects?: string[]; documentClass?: string; revision?: string };
    predecessorContext?: { subjects?: string[]; documentClass?: string; revision?: string };
    texts?: { successor: string; predecessor: string };
  }): Promise<{ runId: string; successorKey: string; predecessorKey: string }> {
    const { runId } = await runningRun([options.name]);
    await coordinator.advance(runId);
    const [queued] = await itemStates(runId);
    const successorKey = queued!.objectKey!;
    const predecessorKey = `${ORG}/${OWNER}/files/prev-policy`;
    await tdb.db
      .update(importItem)
      .set({ revisionOf: predecessorKey })
      .where(eq(importItem.id, queued!.id));
    for (const [key, ctx] of [
      [successorKey, options.successorContext],
      [predecessorKey, options.predecessorContext],
    ] as const) {
      if (!ctx) continue;
      const subjects = JSON.stringify(
        (ctx.subjects ?? []).map((name) => ({ name, confident: true })),
      );
      await tdb.db.execute(sql`
        INSERT INTO source_context (owner_id, source_type, source_id, subjects,
          document_class, document_class_confident, revision, revision_confident)
        VALUES (${OWNER}, 'file', ${key}, ${subjects}::jsonb,
          ${ctx.documentClass ?? null}, ${Boolean(ctx.documentClass)},
          ${ctx.revision ?? null}, ${Boolean(ctx.revision)})
        ON CONFLICT (source_type, source_id) DO UPDATE SET
          subjects = ${subjects}::jsonb,
          document_class = ${ctx.documentClass ?? null},
          revision = ${ctx.revision ?? null}
      `);
    }
    if (options.texts) {
      await objects.putObject(successorKey, Buffer.from('successor-bytes'));
      readerTexts.set('successor-bytes', options.texts.successor);
      readerTexts.set('the original policy text', options.texts.predecessor);
    }
    await settlePipeline(successorKey, 'done');
    await coordinator.advance(runId);
    return { runId, successorKey, predecessorKey };
  }

  const linksFor = async (successorKey: string) => {
    const rows = await revisions.forSource(principal, {
      sourceType: 'file',
      sourceId: successorKey,
    });
    return rows.filter((row) => row.successorId === successorKey);
  };

  it('an anchored later revision links AUTO at high confidence, and the summary counts it', async () => {
    const { runId, successorKey } = await settledCandidate({
      name: 'anchored.pdf',
      successorContext: { documentClass: 'policy', revision: 'v2' },
      predecessorContext: { documentClass: 'policy', revision: 'v1' },
    });
    const links = await linksFor(successorKey);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ status: 'auto' });
    expect(links[0]!.basisJson).toMatchObject({ confidence: 'high', revisionNew: 'v2' });
    const [run] = await tdb.db.select().from(importRun).where(eq(importRun.id, runId));
    expect(run!.countsJson).toMatchObject({ revisionsLinked: 1, revisionsProposed: 0 });
  });

  it('corroborated similarity yields a PROPOSED link at medium confidence', async () => {
    const text =
      'The travel policy applies to all employees of the company and expenses ' +
      'above one hundred euros require written approval from a manager before the trip. ' +
      'Receipts must be submitted to the finance team within thirty days of the trip ' +
      'ending and reimbursement is paid with the next regular salary payment. Flights ' +
      'are booked through the central travel desk and hotel bookings follow the ' +
      'published rate ceiling for the destination city unless no room is available.';
    const { successorKey } = await settledCandidate({
      name: 'corroborated.pdf',
      successorContext: { subjects: ['Acme', 'travel policy'], documentClass: 'policy' },
      predecessorContext: { subjects: ['Acme', 'travel policy'], documentClass: 'policy' },
      texts: { successor: text.replace('one hundred', 'two hundred'), predecessor: text },
    });
    const links = await linksFor(successorKey);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ status: 'proposed', decidedAt: null });
    expect(links[0]!.basisJson).toMatchObject({ confidence: 'medium' });
  });

  it('a bare filename coincidence with nothing corroborating links NOTHING', async () => {
    const { successorKey } = await settledCandidate({
      name: 'coincidence.pdf',
      successorContext: { subjects: ['staffing plan'], documentClass: 'report' },
      predecessorContext: { subjects: ['travel policy'], documentClass: 'policy' },
    });
    expect(await linksFor(successorKey)).toHaveLength(0);
  });

  it('a REJECTED pair is never re-proposed; a manual link overrides even that', async () => {
    const successor = { sourceType: 'file', sourceId: `${ORG}/${OWNER}/files/rejected-succ` };
    const predecessor = { sourceType: 'file', sourceId: `${ORG}/${OWNER}/files/prev-policy` };
    const detected = await revisions.recordDetected(tdb.db, {
      ownerId: OWNER,
      successor,
      predecessor,
      status: 'proposed',
      basis: {
        filename: 'policy.pdf',
        revisionNew: null,
        revisionOld: null,
        subjectOverlap: 0.8,
        classMatch: true,
        shingleSimilarity: 0.9,
        confidence: 'medium',
      },
    });
    await revisions.decide(principal, detected!.id, 'rejected');

    // The detector runs again (a re-import): the rejection stands.
    const again = await revisions.recordDetected(tdb.db, {
      ownerId: OWNER,
      successor,
      predecessor,
      status: 'proposed',
      basis: detected!.basisJson,
    });
    expect(again).toBeNull();
    let [row] = await linksFor(successor.sourceId);
    expect(row!.status).toBe('rejected');

    // The owner's explicit word cuts both ways: manual overrides rejection.
    await revisions.linkManually(principal, successor, predecessor);
    [row] = await linksFor(successor.sourceId);
    expect(row!.status).toBe('manual');
  });

  it('linking writes revision metadata ONLY: fact rows are untouched (the 6.1-ready state)', async () => {
    // The decision record's "facts: nothing new" claim, pinned: recording a
    // link changes no memory-owned row; supersession stays the existing
    // reconciliation's job (exercised live in the compose walk). 6.1 reads
    // the link plus the unchanged fact lifecycle together.
    const before = await tdb.db.execute(
      sql`SELECT (SELECT count(*) FROM memory) AS memories, (SELECT count(*) FROM memory_relation) AS relations`,
    );
    await revisions.recordDetected(tdb.db, {
      ownerId: OWNER,
      successor: { sourceType: 'file', sourceId: `${ORG}/${OWNER}/files/untouched-succ` },
      predecessor: { sourceType: 'file', sourceId: `${ORG}/${OWNER}/files/prev-policy` },
      status: 'auto',
      basis: {
        filename: 'policy.pdf',
        revisionNew: 'v2',
        revisionOld: 'v1',
        subjectOverlap: null,
        classMatch: null,
        shingleSimilarity: null,
        confidence: 'high',
      },
    });
    const after = await tdb.db.execute(
      sql`SELECT (SELECT count(*) FROM memory) AS memories, (SELECT count(*) FROM memory_relation) AS relations`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
