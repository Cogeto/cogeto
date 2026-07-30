import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Principal } from '@cogeto/shared';
import { auditLog } from '../infrastructure/index';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { passportExport } from './persistence/tables';
import { PassportExportCascade } from './passport.source-expiry';

/**
 * SEC-8 / SEC-9: a passport export is a signed ZIP of everything its owner
 * could see when it was assembled, so it must not outlive a deletion, and its
 * lifecycle must be visible in the audit trail.
 *
 * These exercise the cascade directly against a real Postgres. The end-to-end
 * saga path (receipt counts, object erasure by the worker leg) is covered by
 * the deletion integration suite; what matters here is the arm itself:
 * which rows it expires, which keys it hands back, and what it records.
 */
const owner: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};

describe('deletion_expires_exports', () => {
  let tdb: TestDatabase;
  const cascade = new PassportExportCascade();

  beforeAll(async () => {
    tdb = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await tdb.stop();
  });

  const seed = async (
    userId: string,
    status: string,
    objectKey: string | null,
  ): Promise<string> => {
    const [row] = await tdb.db
      .insert(passportExport)
      .values({
        userId,
        orgId: 'org-1',
        passportVersion: '2.0',
        includeOriginals: false,
        status,
        objectKey,
      })
      .returning();
    return row!.id;
  };

  it('expires the owner ready and pending exports and hands back their object keys', async () => {
    const ready = await seed(owner.userId, 'ready', 'org-1/user-a/passport-ready.zip');
    const pending = await seed(owner.userId, 'pending', null);

    const result = await tdb.db.transaction((tx) => cascade.expireForOwner(tx, owner.userId));

    expect(result.count).toBe(2);
    // Only the ready export has bytes; the pending one has nothing to erase yet.
    expect(result.objectKeys).toEqual(['org-1/user-a/passport-ready.zip']);

    const rows = await tdb.db
      .select()
      .from(passportExport)
      .where(eq(passportExport.userId, owner.userId));
    for (const row of rows) {
      expect(row.status).toBe('expired');
      // The key is cleared so no later code path can presign it.
      expect(row.objectKey).toBeNull();
    }
    expect(rows.map((r) => r.id).sort()).toEqual([ready, pending].sort());
  });

  it('never touches another user exports', async () => {
    const mine = await seed(owner.userId, 'ready', 'org-1/user-a/mine.zip');
    const theirs = await seed('user-b', 'ready', 'org-1/user-b/theirs.zip');

    await tdb.db.transaction((tx) => cascade.expireForOwner(tx, owner.userId));

    const [other] = await tdb.db.select().from(passportExport).where(eq(passportExport.id, theirs));
    expect(other!.status).toBe('ready');
    expect(other!.objectKey).toBe('org-1/user-b/theirs.zip');

    const [own] = await tdb.db.select().from(passportExport).where(eq(passportExport.id, mine));
    expect(own!.status).toBe('expired');
  });

  it('leaves already-expired and failed exports alone, and is a no-op when there is nothing', async () => {
    await seed('user-c', 'expired', null);
    await seed('user-c', 'failed', null);

    const result = await tdb.db.transaction((tx) => cascade.expireForOwner(tx, 'user-c'));

    expect(result).toEqual({ count: 0, objectKeys: [] });
  });

  it('records the expiry in the append-only audit trail (SEC-9)', async () => {
    await seed('user-d', 'ready', 'org-1/user-d/x.zip');
    await tdb.db.transaction((tx) => cascade.expireForOwner(tx, 'user-d'));

    const entries = await tdb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'passport.export_expired'), eq(auditLog.ownerId, 'user-d')));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor).toBe('deletion_saga');
    expect(entries[0]!.entityType).toBe('passport_export');
    // Structural metadata only: a count and a reason, never export content.
    expect(entries[0]!.detailJson).toMatchObject({ count: 1, reason: 'source deletion' });
  });
});
