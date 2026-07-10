import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { applyMigrations, writeAudit } from '../infrastructure/index';
import { AuditController } from './audit.controller';
import type { AuthenticatedRequest } from '../identity/index';

const userA: Principal = {
  userId: 'user-a',
  name: 'A',
  email: null,
  orgId: 'org-1',
  orgName: 'One',
  roles: [],
};
const userB: Principal = { ...userA, userId: 'user-b', orgId: 'org-2', orgName: 'Two' };
const req = (p: Principal) => ({ principal: p }) as unknown as AuthenticatedRequest;

describe('audit_read_scoped (integration: real Postgres)', () => {
  let tdb: TestDatabase;
  let controller: AuditController;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    // The controller is guarded by BearerAuthGuard in the module (auth is
    // enforced structurally); here we exercise its org scoping + pagination.
    controller = new AuditController(tdb.db);

    for (let i = 0; i < 5; i++) {
      await writeAudit(tdb.db, {
        actor: 'user:user-a',
        action: 'thing.did',
        entityType: 'memory',
        entityId: `a-${i}`,
        orgId: 'org-1',
      });
    }
    for (let i = 0; i < 3; i++) {
      await writeAudit(tdb.db, {
        actor: 'user:user-b',
        action: 'thing.did',
        entityType: 'memory',
        entityId: `b-${i}`,
        orgId: 'org-2',
      });
    }
    // A system entry with no org — shared/global, not "another org's".
    await writeAudit(tdb.db, {
      actor: 'deletion_saga',
      action: 'sys.thing',
      entityType: 'system',
      entityId: 'sys-1',
    });
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  it('scopes to the caller’s org (plus system entries) and never exposes another org’s', async () => {
    const a = await controller.list(req(userA), { entityType: 'memory' });
    expect(a.total).toBe(5);
    expect(a.items.every((e) => e.entityId.startsWith('a-'))).toBe(true);
    expect(a.items.some((e) => e.entityId.startsWith('b-'))).toBe(false); // never org-2's

    const b = await controller.list(req(userB), { entityType: 'memory' });
    expect(b.total).toBe(3);
    expect(b.items.every((e) => e.entityId.startsWith('b-'))).toBe(true);

    // Null-org system entries are visible to any org (they are not org-owned).
    const sys = await controller.list(req(userA), { entityType: 'system' });
    expect(sys.total).toBe(1);
  });

  it('paginates deterministically without overlap', async () => {
    const page1 = await controller.list(req(userA), { entityType: 'memory', limit: 2, offset: 0 });
    const page2 = await controller.list(req(userA), { entityType: 'memory', limit: 2, offset: 2 });
    expect(page1.total).toBe(5);
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);
    const overlap = page1.items.filter((x) => page2.items.some((y) => y.id === x.id));
    expect(overlap).toHaveLength(0);
  });

  it('detail_owner_gated: entries are org-visible but detail is returned only to the stamped owner (QS-1/QS-13)', async () => {
    // Two users in the SAME org — the org gate admits both; the detail gate
    // must still separate them.
    const a2: Principal = { ...userA, userId: 'peer-x1' };
    const b2: Principal = { ...userA, userId: 'peer-x2' };
    await writeAudit(tdb.db, {
      actor: 'user:peer-x1',
      action: 'memory.status_transition',
      entityType: 'memory',
      entityId: 'owned-by-a2',
      detail: { from: 'active', to: 'outdated' },
      orgId: 'org-1',
      ownerId: 'peer-x1',
    });

    const asOwner = await controller.list(req(a2), { action: 'memory.status_transition' });
    const ownRow = asOwner.items.find((i) => i.entityId === 'owned-by-a2');
    expect(ownRow?.detail).toEqual({ from: 'active', to: 'outdated' });
    expect(ownRow?.detailWithheld).toBeUndefined();

    const asPeer = await controller.list(req(b2), { action: 'memory.status_transition' });
    const peerRow = asPeer.items.find((i) => i.entityId === 'owned-by-a2');
    // The ENTRY is org-visible (who did what to which id) — metadata only.
    expect(peerRow).toBeDefined();
    expect(peerRow?.detail).toBeNull();
    expect(peerRow?.detailWithheld).toBe(true);

    // Ownerless system entries keep their (structural) detail for everyone.
    const sys = (await controller.list(req(b2), { action: 'sys.thing' })).items[0];
    expect(sys?.detailWithheld).toBeUndefined();
  });

  it('scrub_migration: pre-existing rows carrying a free-text reason are redacted, and the scrub is itself audited (QS-1)', async () => {
    // A legacy-shaped row, as written before decision 0025: model free-text
    // paraphrasing private memory content, org-NULL (the pre-0025 writers).
    await writeAudit(tdb.db, {
      actor: 'reconciliation',
      action: 'memory.contradiction_detected',
      entityType: 'memory_relation',
      entityId: 'legacy-relation',
      detail: { a: 'id-a', b: 'id-b', reason: 'Fact A says €48,000, Fact B says €52,000' },
    });

    // Replay migration 0020 (written idempotently for exactly this test): the
    // sanctioned scrub removes the content-bearing key, keeps the metadata.
    await tdb.pool.query(`DELETE FROM cogeto_migrations WHERE name LIKE '0020%'`);
    await applyMigrations(tdb.pool, path.resolve(__dirname, '..', 'migrations'));

    const { rows } = await tdb.pool.query<{ detail_json: Record<string, unknown> }>(
      `SELECT detail_json FROM audit_log WHERE entity_id = 'legacy-relation'`,
    );
    expect(rows[0]?.detail_json).toEqual({ a: 'id-a', b: 'id-b' });

    // The redaction is recorded — a deliberate, audited scrub, not a silent one.
    const { rows: scrubRows } = await tdb.pool.query<{ detail_json: { rows_scrubbed: number } }>(
      `SELECT detail_json FROM audit_log WHERE action = 'audit.detail_scrubbed'
       ORDER BY created_at DESC LIMIT 1`,
    );
    expect(scrubRows[0]?.detail_json.rows_scrubbed).toBeGreaterThanOrEqual(1);

    // And the append-only trigger is back in force after the migration.
    await expect(
      tdb.pool.query(`UPDATE audit_log SET actor = 'x' WHERE entity_id = 'legacy-relation'`),
    ).rejects.toThrow(/append-only/);
  });

  it('filters by actor and action (contains)', async () => {
    const byActor = await controller.list(req(userA), { actor: 'user-a' });
    expect(byActor.total).toBe(5);
    // 'thing.did' matches the 5 org-1 rows but not the null-org 'sys.thing'.
    const byAction = await controller.list(req(userA), { action: 'thing.did' });
    expect(byAction.total).toBe(5); // org-1's 5 (org-2's excluded by scope)
  });
});
