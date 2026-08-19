import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { UserSettingsService } from '../settings/index';
import { createExtractionGateStore, ExtractionGateSpaceCleanup } from '../ingestion/index';
import type { ExtractionGateStore } from '../ingestion/index';

/**
 * The settings split (docs/features/spaces.md section 4, migration 0062):
 * any setting that influences what is extracted, stored, retrieved or
 * answered is space-scoped, per user per space. Two users may hold different
 * capture defaults in one space; one user may hold different defaults in two
 * spaces; a new space begins with sensible defaults rather than empty ones;
 * and the extraction gate that admits a source is the one configured in the
 * source's own space.
 */
describe('settings split (integration: real Postgres)', () => {
  let tdb: TestDatabase;
  let settings: UserSettingsService;
  let gate: ExtractionGateStore;

  const SPACE_B = randomUUID();
  const user: Principal = {
    userId: 'user-split',
    name: 'User',
    email: null,
    orgId: 'org-1',
    orgName: 'Org',
    roles: [],
  };
  const userInB: Principal = { ...user, spaceId: SPACE_B };
  const peer: Principal = { ...user, userId: 'peer-split', name: 'Peer' };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    settings = new UserSettingsService(tdb.db);
    gate = createExtractionGateStore(tdb.db);
    await tdb.pool.query('INSERT INTO space (id, name) VALUES ($1, $2)', [SPACE_B, 'Split B']);
  });
  afterAll(async () => {
    await tdb.stop();
  });

  it('capture_defaults_are_per_user_per_space: one user, two spaces, two sets of defaults', async () => {
    await settings.update(user, { discardByDefault: true, defaultScope: 'shared' });
    await settings.update(userInB, { autoResearch: true });

    expect(await settings.get(user)).toEqual({
      discardByDefault: true,
      defaultScope: 'shared',
      autoResearch: false,
    });
    expect(await settings.get(userInB)).toEqual({
      discardByDefault: false,
      defaultScope: 'private',
      autoResearch: true,
    });
  });

  it('two_users_differ_in_one_space: the row key is (user, space), not the space', async () => {
    expect(await settings.get(peer)).toEqual({
      discardByDefault: false,
      defaultScope: 'private',
      autoResearch: false,
    });
  });

  it('a_new_space_begins_with_sensible_defaults: no row reads as the column defaults', async () => {
    const fresh: Principal = { ...user, spaceId: randomUUID() };
    expect(await settings.get(fresh)).toEqual({
      discardByDefault: false,
      defaultScope: 'private',
      autoResearch: false,
    });
  });

  it('default_scope_lookup_requires_the_space: worker callers name their subject row space', async () => {
    expect(await settings.defaultScopeFor(user.userId, DEFAULT_SPACE_ID)).toBe('shared');
    expect(await settings.defaultScopeFor(user.userId, SPACE_B)).toBe('private');
  });

  it('the_gate_is_sealed_with_its_space: a disabled gate in one space admits in the other', async () => {
    await gate.setGate(user, 'file', { enabled: false });

    const input = (spaceId: string) => ({
      ownerId: user.userId,
      spaceId,
      sourceType: 'file',
      sourceId: 'org-1/user-split/private/file-1',
    });
    expect(await gate.decisionFor(tdb.db, input(DEFAULT_SPACE_ID))).toEqual({
      allowed: false,
      reason: 'extraction_disabled',
    });
    expect((await gate.decisionFor(tdb.db, input(SPACE_B))).allowed).toBe(true);
  });

  it('the_same_rule_may_exist_in_two_spaces: uniqueness gained the dimension', async () => {
    const request = {
      sourceType: 'file',
      dimension: 'document_class' as const,
      value: 'pdf',
      effect: 'deny' as const,
    };
    const inDefault = await gate.addRule(user, request);
    const inB = await gate.addRule(userInB, request);
    expect(inDefault.id).not.toBe(inB.id);
    expect(inB.spaceId).toBe(SPACE_B);

    // And the panel shows one space's configuration, never the union.
    const panelB = await gate.configFor(userInB);
    expect(panelB.rules.map((r) => r.id)).toEqual([inB.id]);
    expect(panelB.gates).toEqual([]);
  });

  it('space_deletion_takes_its_gate_configuration: the cleanup leg removes one space only', async () => {
    const cleanup = new ExtractionGateSpaceCleanup(tdb.db);
    expect(await cleanup.countForSpace(SPACE_B)).toBe(1);
    const removed = await cleanup.cleanupSpace(SPACE_B);
    expect(removed.count).toBe(1);
    expect(await cleanup.countForSpace(SPACE_B)).toBe(0);
    // The default space's gate row and rule are untouched.
    const panelDefault = await gate.configFor(user);
    expect(panelDefault.gates).toHaveLength(1);
    expect(panelDefault.rules).toHaveLength(1);
  });
});
