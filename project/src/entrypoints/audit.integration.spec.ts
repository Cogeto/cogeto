import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { writeAudit } from '../infrastructure/index';
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

  it('filters by actor and action (contains)', async () => {
    const byActor = await controller.list(req(userA), { actor: 'user-a' });
    expect(byActor.total).toBe(5);
    // 'thing.did' matches the 5 org-1 rows but not the null-org 'sys.thing'.
    const byAction = await controller.list(req(userA), { action: 'thing.did' });
    expect(byAction.total).toBe(5); // org-1's 5 (org-2's excluded by scope)
  });
});
