import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Principal } from '@cogeto/shared';
import { readAuditEntries } from '../infrastructure/index';
import type { Tx } from '../infrastructure/index';
import { DeletionSaga } from '../memory/index';
import type { SourceDeletion } from '../memory/index';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { findingsReport } from './persistence/tables';
import { FindingsReportCascade } from './report.source-expiry';
import { ReportStore } from './report.store';

/**
 * Deletion coverage for the findings report (V2.3 item 6.2, issue D3): the
 * second content-bearing derived artifact after the passport, covered by the
 * saga the same way so the passport gap cannot recur. The cascade expires the
 * owner's runs, the receipt counts them (`findings_reports_expired`) and
 * carries both artifacts' object keys for the worker leg and the sweep, and
 * the SEC-8 mid-assembly race cannot resurrect an expired run.
 */
const owner: Principal = {
  userId: 'user-fr',
  name: 'User',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};

/** A minimal source adapter so the saga has a deletable source to act on. */
class FakeNoteDeletion implements SourceDeletion {
  readonly sourceType = 'user_note' as const;
  readonly sources = new Map<string, string>([['note-1', owner.userId]]);
  async ownerOf(_tx: Tx, sourceId: string): Promise<string | null> {
    return this.sources.get(sourceId) ?? null;
  }
  async deleteSource(_tx: Tx, sourceId: string): Promise<void> {
    this.sources.delete(sourceId);
  }
}

describe('deletion_expires_findings_reports', () => {
  let tdb: TestDatabase;
  const cascade = new FindingsReportCascade();

  beforeAll(async () => {
    tdb = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await tdb.stop();
  });

  const seed = async (
    status: 'pending' | 'running' | 'ready' | 'failed' | 'expired',
    keys: { json: string | null; pdf: string | null },
  ): Promise<string> => {
    const [row] = await tdb.db
      .insert(findingsReport)
      .values({
        userId: owner.userId,
        orgId: owner.orgId,
        reportVersion: '1.0',
        locale: 'en',
        scopeJson: { kind: 'corpus' },
        scopeKey: '{"kind":"corpus"}',
        status,
        jsonObjectKey: keys.json,
        pdfObjectKey: keys.pdf,
      })
      .returning();
    return row!.id;
  };

  it('expires the owner in-flight and ready runs and hands back BOTH formats object keys', async () => {
    const ready = await seed('ready', {
      json: 'org-1/user-fr/exports/findings-report-a.json',
      pdf: 'org-1/user-fr/exports/findings-report-a.pdf',
    });
    const running = await seed('running', { json: null, pdf: null });

    const result = await tdb.db.transaction((tx) => cascade.expireForOwner(tx, owner.userId));

    expect(result.count).toBe(2);
    expect(result.objectKeys.sort()).toEqual([
      'org-1/user-fr/exports/findings-report-a.json',
      'org-1/user-fr/exports/findings-report-a.pdf',
    ]);

    const rows = await tdb.db
      .select()
      .from(findingsReport)
      .where(eq(findingsReport.userId, owner.userId));
    for (const row of rows) {
      expect(row.status).toBe('expired');
      expect(row.jsonObjectKey).toBeNull();
      expect(row.pdfObjectKey).toBeNull();
    }
    expect(rows.map((r) => r.id).sort()).toEqual([ready, running].sort());

    // The expiry left its trace (issue D4): actor, action, count.
    const audit = await readAuditEntries(tdb.db, { actions: ['report.expired'] });
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]).toMatchObject({ actor: 'deletion_saga' });
  });

  it('a run expired mid-assembly cannot be published afterwards (the SEC-8 race)', async () => {
    const store = new ReportStore(tdb.db);
    const inFlight = await seed('running', { json: null, pdf: null });

    await tdb.db.transaction((tx) => cascade.expireForOwner(tx, owner.userId));

    const published = await store.markReady(inFlight, {
      jsonObjectKey: 'org-1/user-fr/exports/findings-report-raced.json',
      pdfObjectKey: 'org-1/user-fr/exports/findings-report-raced.pdf',
      jsonSizeBytes: 10,
      pdfSizeBytes: 10,
      payloadSha256: 'aa',
      signature: 'bb',
      modelConfigId: 'test',
      counts: null,
      previousReportId: null,
      readyAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    expect(published).toBe(false);
    const [row] = await tdb.db.select().from(findingsReport).where(eq(findingsReport.id, inFlight));
    expect(row!.status).toBe('expired');
    expect(row!.jsonObjectKey).toBeNull();
  });

  it('the deletion receipt counts expired reports and carries their object keys', async () => {
    await seed('ready', {
      json: 'org-1/user-fr/exports/findings-report-b.json',
      pdf: 'org-1/user-fr/exports/findings-report-b.pdf',
    });

    // The saga with the cascade bound exactly as the composition roots bind it.
    const adapter = new FakeNoteDeletion();
    const saga = new DeletionSaga(tdb.db, {
      adapters: [adapter],
      derivedCascades: [cascade],
    });
    const { receiptId } = await saga.requestSourceDeletion(owner, 'user_note', 'note-1');
    expect(receiptId).not.toBeNull();

    const { rows } = await tdb.pool.query<{ counts_json: Record<string, unknown> }>(
      'SELECT counts_json FROM deletion_receipt WHERE id = $1',
      [receiptId],
    );
    const counts = rows[0]!.counts_json;
    // Earlier cases left every report expired; this deletion expired the one
    // freshly seeded ready run.
    expect(counts['findings_reports_expired']).toBe(1);
    expect(counts['object_keys']).toEqual(
      expect.arrayContaining([
        'org-1/user-fr/exports/findings-report-b.json',
        'org-1/user-fr/exports/findings-report-b.pdf',
      ]),
    );
  });

  it('the download of an expired run is refused with the reason (issue D3)', async () => {
    const store = new ReportStore(tdb.db);
    const expired = (
      await tdb.db
        .select()
        .from(findingsReport)
        .where(eq(findingsReport.status, 'expired'))
        .limit(1)
    )[0]!;
    // The service-level refusal wording is exercised in the flow spec; here
    // the store-level invariant: an expired row exposes no object key for any
    // later code path to presign.
    const row = await store.getForOwner(owner.userId, expired.id);
    expect(row!.status).toBe('expired');
    expect(row!.jsonObjectKey).toBeNull();
    expect(row!.pdfObjectKey).toBeNull();
  });
});
