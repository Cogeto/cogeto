import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { InMemoryRateLimitStore } from '../infrastructure/index';
import { ConnectorRegistry } from './connector-registry';
import { ConnectorStore } from './persistence/connector-store';
import { ConnectorWebhookController } from './webhook.controller';
import { FakeUpstream, referenceConnector } from './testing/reference-connector';
import type { ConnectorRow } from './persistence/tables';

/**
 * The ingress endpoint's own defence order (V2.5 item 8.1, issue D2): the
 * endpoint is unauthenticated by nature, so what it refuses, and BEFORE how
 * much work, is the security property. The signature math itself is covered
 * by domain/webhook-verify.spec.ts; this exercises the controller's glue:
 * size caps, unknown targets, refusal before parsing, dedup, and the fast
 * acknowledge-and-enqueue shape.
 */

const MASTER_KEY = randomBytes(32);
const OWNER = 'user-ingress';
const ORG = 'org-ingress';

function request(body: Buffer, headers: Record<string, string> = {}): Request {
  return { body, headers } as unknown as Request;
}

describe('connector_webhook_ingress', () => {
  let tdb: TestDatabase;
  let upstream: FakeUpstream;
  let store: ConnectorStore;
  let controller: ConnectorWebhookController;
  let row: ConnectorRow;
  let secret: string;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    upstream = new FakeUpstream();
    store = new ConnectorStore(tdb.db, { masterKey: MASTER_KEY });
    const registry = new ConnectorRegistry([referenceConnector(upstream)]);
    controller = new ConnectorWebhookController(
      tdb.db,
      { masterKey: MASTER_KEY, webhookMaxPerWindow: 5, webhookRateWindowSeconds: 60 },
      registry,
      store,
      new InMemoryRateLimitStore(),
    );
    row = await store.create({ ownerId: OWNER, orgId: ORG, kind: 'reference', name: 'Ref' });
    await store.transition(tdb.db, row, 'authorised', { actor: 'test' });
    secret = await store.rotateWebhookSecret(row);
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  it('refuses_an_empty_or_oversized_body_before_anything_else', async () => {
    await expect(controller.receive(row.id, request(Buffer.alloc(0)))).rejects.toMatchObject({
      status: 413,
    });
    await expect(
      controller.receive(row.id, request(Buffer.alloc(2 * 1024 * 1024))),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('no_existence_oracle: an unknown connector is indistinguishable from a bad signature', async () => {
    // Issue #636. These answered 404 while a bad signature answered 403, so an
    // unauthenticated caller holding no secret could walk identifiers and read
    // which connectors an instance has, and which of them are live, straight
    // off the status code. Every pre-verification refusal is now the same 403
    // with the same body; only the log distinguishes them.
    const delivery = upstream.signDelivery(secret, 'evt-x', []);
    const malformed = controller.receive('not-a-uuid', request(delivery.body, delivery.headers));
    const unknown = controller.receive(
      '00000000-0000-4000-8000-000000000000',
      request(delivery.body, delivery.headers),
    );
    // A real connector with a wrong signature: the response an attacker is
    // trying to tell the two above apart from.
    const wrongKey = upstream.signDelivery('not-the-secret', 'evt-x2', []);
    const badSignature = controller.receive(row.id, request(wrongKey.body, wrongKey.headers));

    const responses = await Promise.all(
      [malformed, unknown, badSignature].map((p) =>
        p.then(
          () => ({ status: 0, message: 'unexpectedly accepted' }),
          (error: { status?: number; message?: string }) => ({
            status: error.status,
            message: error.message,
          }),
        ),
      ),
    );
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[1]).toEqual(responses[2]);
    expect(responses[0]?.status).toBe(403);
  });

  it('refuses_unsigned_and_badly_signed_payloads_before_parsing', async () => {
    // A body that is not even JSON: with a bad signature it must be refused
    // by the signature check, never reaching a parser that could throw on it.
    const garbage = Buffer.from('%%% not json %%%', 'utf8');
    await expect(controller.receive(row.id, request(garbage))).rejects.toMatchObject({
      status: 403,
    });
    const wrongKey = upstream.signDelivery('not-the-secret', 'evt-y', []);
    await expect(
      controller.receive(row.id, request(wrongKey.body, wrongKey.headers)),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('accepts_a_valid_delivery_and_dedups_the_replay_with_a_calm_200', async () => {
    const delivery = upstream.signDelivery(secret, 'evt-1', ['a1']);
    const first = await controller.receive(row.id, request(delivery.body, delivery.headers));
    expect(first).toEqual({ accepted: true });
    // The identical delivery again: 200, nothing recorded, nothing enqueued,
    // so upstream retry storms are harmless.
    const replay = await controller.receive(row.id, request(delivery.body, delivery.headers));
    expect(replay).toEqual({ accepted: false });
  });

  it('rate_limits_per_connector_with_429', async () => {
    // Earlier cases in this suite already spent part of the window (the
    // rate check deliberately runs BEFORE signature work); flooding must
    // hit the wall within the window's size.
    let refused = false;
    for (let i = 0; i < 7 && !refused; i += 1) {
      const delivery = upstream.signDelivery(secret, `evt-flood-${i}`, []);
      try {
        await controller.receive(row.id, request(delivery.body, delivery.headers));
      } catch (error) {
        expect((error as { getStatus(): number }).getStatus()).toBe(429);
        refused = true;
      }
    }
    expect(refused).toBe(true);
  });
});
