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

    // The gate now matches an allowlisted address and a domain member.
    expect(await service.matches(owner.userId, 'ana@adriatic-foods.hr')).toBe(true);
    expect(await service.matches(owner.userId, 'anyone@trusted.example')).toBe(true);
    expect(await service.matches(owner.userId, 'stranger@example.net')).toBe(false);

    // Remove the address entry; a foreign id cannot remove it.
    expect(await service.removeEntry({ ...owner, userId: 'someone-else' }, address.id)).toBe(false);
    expect(await service.removeEntry(owner, address.id)).toBe(true);
    expect(await service.matches(owner.userId, 'ana@adriatic-foods.hr')).toBe(false);

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
});
