import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase, startTestMinio } from '../testing/index';
import type { TestDatabase, TestMinio } from '../testing/index';
import { MemoryFileStore, MemoryObjectStore } from '../memory/index';
import { UserDirectory } from '../identity/index';
import { UserSettingsService } from '../settings/index';
import { EmailAllowlistService } from './email-allowlist.service';
import { EmailIntakeService } from './email-intake.service';
import { EmailRoutingSpaceCleanup } from './email-space-cleanup';
import type { MailOptions } from './mail-options';

/**
 * Email intake routing (docs/features/spaces.md section 6c, issue A):
 * inbound mail resolves to exactly one space BEFORE anything is stored.
 * An alias rule wins, then the matched sender rule's target, then the
 * default space; an alias the recipient has not defined is REFUSED with a
 * recorded, owner-attributed reason and ingests nothing; a routing rule dies
 * with its target space, so mail that targeted a deleted space refuses
 * legibly instead of falling anywhere.
 *
 * Real Postgres + MinIO; no model, no pipeline: routing is decided before
 * extraction, which is the point.
 */

const INBOUND = 'capture@in.localhost';
const SPACE_B = 'bbbbbbbb-0000-4000-8000-000000000001';
const SPACE_C = 'cccccccc-0000-4000-8000-000000000001';
const SPACE_D = 'dddddddd-0000-4000-8000-000000000001';

const owner: Principal = {
  userId: 'user-route',
  name: 'Router',
  email: 'router@instance.test',
  orgId: 'org-route',
  orgName: 'Org',
  roles: [],
};

function rawEmail(opts: { from: string; to?: string; text?: string }): Buffer {
  const head = [
    `From: ${opts.from}`,
    `To: ${opts.to ?? INBOUND}`,
    'Subject: Routing test',
    `Message-ID: <${Math.random().toString(36).slice(2)}@cogeto.test>`,
    'Date: Tue, 18 Aug 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  return Buffer.from(`${head.join('\r\n')}\r\n\r\n${opts.text ?? 'The flange is 3.2 mm.'}\r\n`);
}

describe('email intake routing to spaces (integration: real Postgres + MinIO)', () => {
  let tdb: TestDatabase;
  let minio: TestMinio;
  let allowlist: EmailAllowlistService;
  let intake: EmailIntakeService;

  const options: MailOptions = {
    inboundAddress: INBOUND,
    maxBytes: 25 * 1024 * 1024,
    attachmentsMaxBytes: 25 * 1024 * 1024,
    adminUserEmail: 'admin@instance.test',
    intakeToken: 'test-token',
    requireAuthenticatedSender: false,
    intakeMaxPerSenderPerWindow: 0,
    intakeRateWindowSeconds: 3600,
  };
  const envelopeFor = (from: string, to: string = INBOUND) => ({ mailFrom: from, rcptTo: to });

  const emailSpaces = async (): Promise<string[]> =>
    (
      await tdb.pool.query(
        `SELECT space_id FROM email_message WHERE owner_id = $1 ORDER BY created_at`,
        [owner.userId],
      )
    ).rows.map((r: { space_id: string }) => r.space_id);
  const emailCount = async (): Promise<number> =>
    Number(
      (
        await tdb.pool.query(`SELECT count(*) FROM email_message WHERE owner_id = $1`, [
          owner.userId,
        ])
      ).rows[0].count,
    );
  const refusals = async (reason: string) =>
    (
      await tdb.pool.query(`SELECT owner_id, to_addr FROM email_refusal WHERE reason = $1`, [
        reason,
      ])
    ).rows as { owner_id: string | null; to_addr: string | null }[];

  beforeAll(async () => {
    [tdb, minio] = await Promise.all([startTestDatabase(), startTestMinio()]);
    const objects = new MemoryObjectStore({
      url: minio.url,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
      bucket: 'cogeto',
    });
    await objects.ensureBucket();
    const directory = new UserDirectory(tdb.db);
    await directory.record(owner);
    allowlist = new EmailAllowlistService(tdb.db);
    intake = new EmailIntakeService(
      tdb.db,
      objects,
      new MemoryFileStore(tdb.db),
      allowlist,
      directory,
      new UserSettingsService(tdb.db),
      options,
    );
    for (const [id, name] of [
      [SPACE_B, 'Client B'],
      [SPACE_C, 'Client C'],
      [SPACE_D, 'Doomed'],
    ]) {
      await tdb.pool.query(`INSERT INTO space (id, name) VALUES ($1, $2)`, [id, name]);
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), minio.stop()]);
  });

  it('mail_matching_a_sender_rule_lands_in_that_rule_space: resolved before storage, stamped on the row', async () => {
    await allowlist.addEntry(owner, {
      kind: 'address',
      value: 'ana@client-b.example',
      spaceId: SPACE_B,
    });
    const result = await intake.intake(
      rawEmail({ from: 'ana@client-b.example' }),
      envelopeFor('ana@client-b.example'),
    );
    expect(result.accepted).toBe(true);
    expect(await emailSpaces()).toEqual([SPACE_B]);
  });

  it('mail_matching_nothing_lands_in_the_recipient_default_space: the instance default, never last-used', async () => {
    // Self-routed mail (the sender IS the recipient) carries no sender rule
    // and no alias, so it lands in the default space.
    const result = await intake.intake(rawEmail({ from: owner.email! }), envelopeFor(owner.email!));
    expect(result.accepted).toBe(true);
    expect((await emailSpaces()).at(-1)).toBe(DEFAULT_SPACE_ID);
  });

  it('an_address_rule_outranks_a_domain_rule: the more specific target wins', async () => {
    await allowlist.addEntry(owner, {
      kind: 'domain',
      value: 'client-c.example',
      spaceId: DEFAULT_SPACE_ID,
    });
    await allowlist.addEntry(owner, {
      kind: 'address',
      value: 'boss@client-c.example',
      spaceId: SPACE_C,
    });
    await intake.intake(
      rawEmail({ from: 'boss@client-c.example' }),
      envelopeFor('boss@client-c.example'),
    );
    expect((await emailSpaces()).at(-1)).toBe(SPACE_C);
    // The domain rule still routes every OTHER sender of that domain.
    await intake.intake(
      rawEmail({ from: 'colleague@client-c.example' }),
      envelopeFor('colleague@client-c.example'),
    );
    expect((await emailSpaces()).at(-1)).toBe(DEFAULT_SPACE_ID);
  });

  it('two_aliases_route_independently: each plus-tag lands in its own space, outranking the sender rule', async () => {
    await allowlist.addAlias(owner, { alias: 'clientb', spaceId: SPACE_B });
    await allowlist.addAlias(owner, { alias: 'clientc', spaceId: SPACE_C });
    // The sender rule for this sender targets SPACE_B; the alias wins.
    await intake.intake(
      rawEmail({ from: 'ana@client-b.example', to: `capture+clientc@in.localhost` }),
      envelopeFor('ana@client-b.example', 'capture+clientc@in.localhost'),
    );
    expect((await emailSpaces()).at(-1)).toBe(SPACE_C);
    await intake.intake(
      rawEmail({ from: owner.email!, to: `capture+clientb@in.localhost` }),
      envelopeFor(owner.email!, 'capture+clientb@in.localhost'),
    );
    expect((await emailSpaces()).at(-1)).toBe(SPACE_B);
  });

  it('an_undefined_alias_is_refused_with_a_recorded_owner_attributed_reason_and_ingests_nothing', async () => {
    const before = await emailCount();
    const result = await intake.intake(
      rawEmail({ from: owner.email!, to: 'capture+nosuch@in.localhost' }),
      envelopeFor(owner.email!, 'capture+nosuch@in.localhost'),
    );
    expect(result).toMatchObject({ accepted: false, status: 'refused' });
    expect(await emailCount()).toBe(before);
    const recorded = await refusals('alias_not_recognized');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      owner_id: owner.userId,
      to_addr: 'capture+nosuch@in.localhost',
    });
  });

  it('mail_whose_target_space_no_longer_exists_is_refused_with_a_recorded_reason: the rules died with the space', async () => {
    await allowlist.addAlias(owner, { alias: 'doomed', spaceId: SPACE_D });
    await allowlist.addEntry(owner, {
      kind: 'address',
      value: 'vendor@doomed.example',
      spaceId: SPACE_D,
    });
    // Space deletion's email leg removes every rule targeting the space,
    // which is what lets the space row itself be deleted (NO ACTION FKs).
    const cleanup = new EmailRoutingSpaceCleanup(tdb.db);
    expect(await cleanup.countForSpace(SPACE_D)).toBe(2);
    const { count } = await cleanup.cleanupSpace(SPACE_D);
    expect(count).toBe(2);
    await tdb.pool.query(`DELETE FROM space WHERE id = $1`, [SPACE_D]);

    const before = await emailCount();
    // The alias no longer exists → refused and recorded, nothing ingested.
    const viaAlias = await intake.intake(
      rawEmail({ from: owner.email!, to: 'capture+doomed@in.localhost' }),
      envelopeFor(owner.email!, 'capture+doomed@in.localhost'),
    );
    expect(viaAlias.accepted).toBe(false);
    expect(await refusals('alias_not_recognized')).toHaveLength(2);
    // The sender rule died too → the sender is simply not recognized, never
    // re-routed anywhere.
    const viaSender = await intake.intake(
      rawEmail({ from: 'vendor@doomed.example' }),
      envelopeFor('vendor@doomed.example'),
    );
    expect(viaSender.accepted).toBe(false);
    expect((await refusals('sender_not_recognized')).length).toBeGreaterThanOrEqual(1);
    expect(await emailCount()).toBe(before);
  });

  it('an_alias_with_an_unknown_space_is_refused_at_configuration_time: the FK is the loud backstop', async () => {
    await expect(
      allowlist.addAlias(owner, {
        alias: 'orphan',
        spaceId: 'eeeeeeee-0000-4000-8000-000000000001',
      }),
    ).rejects.toThrow(/space no longer exists/);
  });
});
