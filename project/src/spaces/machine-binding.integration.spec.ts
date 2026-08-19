import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { MachineBindingService } from './machine-binding.service';

/**
 * Machine callers' per-credential space bindings (docs/features/spaces.md
 * section 6c, issue C): administrator-managed rows, one space per machine
 * user, rebindable deliberately, and CASCADE with the space, so a deleted
 * space UNBINDS the machine and the guard refuses it loudly instead of
 * letting it degrade anywhere. Real Postgres.
 */

const SPACE_A = 'aaaaaaaa-0000-4000-8000-00000000ab01';
const SPACE_B = 'bbbbbbbb-0000-4000-8000-00000000ab02';

const admin: Principal = {
  userId: 'admin-1',
  name: 'Admin',
  email: 'admin@instance.test',
  orgId: 'org-m',
  orgName: 'Org',
  roles: ['admin'],
};

describe('machine space bindings (integration: real Postgres)', () => {
  let tdb: TestDatabase;
  let bindings: MachineBindingService;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    for (const [id, name] of [
      [SPACE_A, 'Space A'],
      [SPACE_B, 'Space B'],
    ]) {
      await tdb.pool.query(`INSERT INTO space (id, name) VALUES ($1, $2)`, [id, name]);
    }
    bindings = new MachineBindingService(tdb.db);
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  it('bind_rebind_unbind: one space per machine user, audited, never a dangling target', async () => {
    expect(await bindings.spaceFor('svc-1')).toBeNull();
    await bindings.bind(admin, 'svc-1', SPACE_A);
    expect(await bindings.spaceFor('svc-1')).toBe(SPACE_A);
    // Rebinding is a deliberate administrator act, an upsert.
    await bindings.bind(admin, 'svc-1', SPACE_B);
    expect(await bindings.spaceFor('svc-1')).toBe(SPACE_B);
    expect((await bindings.list()).map((b) => b.userId)).toContain('svc-1');
    // Binding to a space that does not exist is refused loudly.
    await expect(
      bindings.bind(admin, 'svc-1', 'eeeeeeee-0000-4000-8000-00000000ab99'),
    ).rejects.toThrow(/space no longer exists/);
    expect(await bindings.unbind(admin, 'svc-1')).toBe(true);
    expect(await bindings.spaceFor('svc-1')).toBeNull();
    expect(await bindings.unbind(admin, 'svc-1')).toBe(false);
  });

  it('a_deleted_space_unbinds_its_machines: CASCADE, so the guard then refuses instead of degrading', async () => {
    await bindings.bind(admin, 'svc-2', SPACE_B);
    await tdb.pool.query(`DELETE FROM space WHERE id = $1`, [SPACE_B]);
    expect(await bindings.spaceFor('svc-2')).toBeNull();
  });
});
