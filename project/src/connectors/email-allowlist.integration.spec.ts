import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { EmailAllowlistService } from './email-allowlist.service';

const owner: Principal = {
  userId: 'user-allow',
  name: 'Owner',
  email: 'owner@instance.test',
  orgId: 'org-allow',
  orgName: 'Org',
  roles: [],
};

describe('email allowlist management (integration: real Postgres)', () => {
  let tdb: TestDatabase;
  let service: EmailAllowlistService;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    service = new EmailAllowlistService(tdb.db);
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  const auditActions = async (): Promise<string[]> => {
    const { rows } = await tdb.pool.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE entity_type = 'email_allowlist' AND owner_id = $1 ORDER BY created_at",
      [owner.userId],
    );
    return rows.map((r) => r.action);
  };

  it('allowlist_managed: add/remove address and domain entries, normalized and audited', async () => {
    // Add an address entry (normalized: lower-cased).
    const address = await service.addEntry(owner, {
      kind: 'address',
      value: 'Ana@Adriatic-Foods.HR',
      note: 'supplier',
    });
    expect(address.kind).toBe('address');
    expect(address.value).toBe('ana@adriatic-foods.hr');
    expect(address.note).toBe('supplier');

    // Add a whole-domain entry (normalized: bare, lower-cased).
    const domain = await service.addEntry(owner, { kind: 'domain', value: '@Trusted.Example' });
    expect(domain.kind).toBe('domain');
    expect(domain.value).toBe('trusted.example');

    // Both are listed, newest first.
    const listed = await service.listForOwner(owner.userId);
    expect(listed.map((e) => e.value).sort()).toEqual(['ana@adriatic-foods.hr', 'trusted.example']);

    // Adding an existing entry is idempotent (no duplicate).
    await service.addEntry(owner, { kind: 'address', value: 'ana@adriatic-foods.hr' });
    expect((await service.listForOwner(owner.userId)).length).toBe(2);

    // The routing now matches an allowlisted address and a domain member to
    // the owner (decision 0031 rule 2); a stranger matches nobody.
    expect(await service.ownersMatching('ana@adriatic-foods.hr')).toContain(owner.userId);
    expect(await service.ownersMatching('anyone@trusted.example')).toContain(owner.userId);
    expect(await service.ownersMatching('stranger@example.net')).toEqual([]);

    // Remove the address entry; a foreign id cannot remove it.
    expect(await service.removeEntry({ ...owner, userId: 'someone-else' }, address.id)).toBe(false);
    expect(await service.removeEntry(owner, address.id)).toBe(true);
    expect(await service.ownersMatching('ana@adriatic-foods.hr')).not.toContain(owner.userId);

    // Add + remove are audited (the idempotent re-add wrote no second row).
    expect(await auditActions()).toEqual([
      'email_allowlist.add',
      'email_allowlist.add',
      'email_allowlist.remove',
    ]);
  });

  it('rejects malformed values', async () => {
    await expect(
      service.addEntry(owner, { kind: 'address', value: 'not-an-address' }),
    ).rejects.toThrow();
    await expect(service.addEntry(owner, { kind: 'domain', value: 'localhost' })).rejects.toThrow();
  });

  it('refusal_scoping_and_retention (SEC-8/SEC-6): owner filter is applied before the limit, and old rows are pruned', async () => {
    // 25 NEWER refusals for a different owner, then one for our owner.
    for (let i = 0; i < 25; i++) {
      await service.recordRefusal(tdb.db, {
        ownerId: 'other-user',
        fromAddr: `x${i}@ext.test`,
        toAddr: null,
        reason: 'not allowlisted',
      });
    }
    await service.recordRefusal(tdb.db, {
      ownerId: owner.userId,
      fromAddr: 'mine@ext.test',
      toAddr: null,
      reason: 'not allowlisted',
    });

    // SEC-8: our owner's refusal is not crowded out of the window by the 25
    // newer other-owner rows (the owner/null filter is in the WHERE, before LIMIT).
    const recent = await service.recentRefusalsForOwner(owner.userId);
    expect(recent.map((r) => r.fromAddr)).toContain('mine@ext.test');
    expect(recent.map((r) => r.fromAddr)).not.toContain('x0@ext.test'); // other owner filtered out

    // SEC-6: age our row past the window; the retention pass prunes it.
    await tdb.pool.query(
      `UPDATE email_refusal SET refused_at = now() - interval '40 days' WHERE from_addr = 'mine@ext.test'`,
    );
    const removed = await service.pruneRefusalsOlderThan(30);
    expect(removed).toBeGreaterThanOrEqual(1);
    const afterPrune = await service.recentRefusalsForOwner(owner.userId);
    expect(afterPrune.map((r) => r.fromAddr)).not.toContain('mine@ext.test');
  });
});
