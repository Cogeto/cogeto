import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureInstanceKeys, loadInstanceSigner } from '../../infrastructure/index';
import type { InstanceSigner } from '../../infrastructure/index';
import { canonicalize, GENESIS_HASH, hashReceiptPayload, verifyChain } from './receipt-chain';
import type { ConfirmedReceipt } from './receipt-chain';
import { parseReceiptCounts } from '../deletion-saga';

/**
 * receipt_chain_survives_task_removal (— risk
 * point 1).
 *
 * `counts_json.tasks_removed` was written into signed, hash-chained deletion
 * receipts for the whole life of the task subsystem. Removing the subsystem
 * must not invalidate one byte of that history: the canonicalization function
 * and `verifyChain` are unchanged, new receipts simply omit the field, and the
 * schema keeps it optional forever.
 *
 * The fixture below is a receipt as the pre-2.0 saga wrote it`tasks_removed`
 * present, in the exact key order the old code emitted (canonicalization sorts,
 * so the order is a red herring the test deliberately includes). It is hashed
 * and signed with a real instance key, then verified with the CURRENT code.
 */

/** A `counts_json` exactly as the pre-removal saga produced it. */
const HISTORICAL_COUNTS = {
  source: { type: 'user_note', id: 'note-2f1c' },
  requested_by: 'user-ana',
  memory_ids: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
  memory_count: 2,
  tasks_removed: 3,
  chat_messages_redacted: 0,
  reply_drafts_redacted: 0,
  point_ids: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
  object_keys: [],
  superseded_by_nulled: [],
  enumerated_at: '2026-05-04T09:12:33.481Z',
};

describe('receipt_chain_survives_task_removal', () => {
  let signer: InstanceSigner;
  let publicKeyPem: string;

  beforeAll(async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'receipt-chain-0060-'));
    await ensureInstanceKeys(keyDir);
    signer = await loadInstanceSigner(keyDir);
    publicKeyPem = signer.publicKeyPem;
  });

  const sign = (bytes: Buffer): string => signer.sign(bytes);

  it('a historical receipt carrying tasks_removed still parses, hashes and verifies', () => {
    const payload = {
      id: '33333333-3333-4333-8333-333333333333',
      source_type: 'user_note',
      source_id: 'note-2f1c',
      counts_json: HISTORICAL_COUNTS,
      signed_at: '2026-05-04T09:12:34.002Z',
      confirmed_at: '2026-05-04T09:12:34.002Z',
      prev_hash: GENESIS_HASH,
    };
    // The counts schema still accepts the field — the executor parses stored
    // receipts on every retry, so dropping it would break replay, not just reads.
    const parsed = parseReceiptCounts(HISTORICAL_COUNTS);
    expect(parsed.tasks_removed).toBe(3);

    const hash = hashReceiptPayload(payload);
    const receipt: ConfirmedReceipt = {
      ...payload,
      hash,
      signature: sign(Buffer.from(hash, 'utf8')),
    };

    const result = verifyChain([receipt], publicKeyPem);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(1);
  });

  it('canonicalization of a tasks_removed payload is unchanged (the hash is a frozen constant)', () => {
    // A pinned expectation, not a re-derivation: if canonicalize ever changes
    // shape — key order, escaping, undefined handling — this fails, and every
    // historical receipt on every instance would have silently stopped
    // verifying. The literal below was computed with the pre-removal code.
    expect(canonicalize({ b: 1, a: { d: 2, c: [3, 1] } })).toBe('{"a":{"c":[3,1],"d":2},"b":1}');
    // tasks_removed sorts between superseded_by_nulled and… nothing special
    // it is an ordinary key, which is exactly why keeping it optional suffices.
    expect(canonicalize(HISTORICAL_COUNTS)).toContain('"tasks_removed":3');
    expect(canonicalize(HISTORICAL_COUNTS)).toBe(
      '{"chat_messages_redacted":0,' +
        '"enumerated_at":"2026-05-04T09:12:33.481Z",' +
        '"memory_count":2,' +
        '"memory_ids":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"],' +
        '"object_keys":[],' +
        '"point_ids":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"],' +
        '"reply_drafts_redacted":0,' +
        '"requested_by":"user-ana",' +
        '"source":{"id":"note-2f1c","type":"user_note"},' +
        '"superseded_by_nulled":[],' +
        '"tasks_removed":3}',
    );
  });

  it('a chain mixing a historical (with) and a new (without) receipt verifies end to end', () => {
    const historical = {
      id: '44444444-4444-4444-8444-444444444444',
      source_type: 'user_note',
      source_id: 'note-old',
      counts_json: HISTORICAL_COUNTS,
      signed_at: '2026-05-04T09:12:34.002Z',
      confirmed_at: '2026-05-04T09:12:34.002Z',
      prev_hash: GENESIS_HASH,
    };
    const historicalHash = hashReceiptPayload(historical);

    // What the saga writes NOW: same shape, tasks_removed simply absent.
    const { tasks_removed: _dropped, ...currentCounts } = HISTORICAL_COUNTS;
    const current = {
      id: '55555555-5555-4555-8555-555555555555',
      source_type: 'user_note',
      source_id: 'note-new',
      counts_json: currentCounts,
      signed_at: '2026-07-28T10:00:00.000Z',
      confirmed_at: '2026-07-28T10:00:00.000Z',
      prev_hash: historicalHash,
    };
    const currentHash = hashReceiptPayload(current);

    const chain: ConfirmedReceipt[] = [
      { ...historical, hash: historicalHash, signature: sign(Buffer.from(historicalHash)) },
      { ...current, hash: currentHash, signature: sign(Buffer.from(currentHash)) },
    ];
    const result = verifyChain(chain, publicKeyPem);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(2);
    // And the new receipt genuinely omits the field.
    expect(parseReceiptCounts(currentCounts).tasks_removed).toBeUndefined();
  });
});
