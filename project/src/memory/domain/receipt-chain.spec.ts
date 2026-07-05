import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalize, GENESIS_HASH, hashReceiptPayload, verifyChain } from './receipt-chain';
import type { ConfirmedReceipt, ReceiptChainPayload } from './receipt-chain';

/**
 * Canonicalization stability is load-bearing: the hash of a receipt written
 * today must be recomputable years later. A drift here is a broken chain.
 */
describe('receipt chain canonicalization (unit)', () => {
  it('is independent of object key insertion order, at every depth', () => {
    const a = canonicalize({ b: 1, a: { d: [1, 2], c: 'x' } });
    const b = canonicalize({ a: { c: 'x', d: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
  });

  it('preserves array order (arrays are sequences, not sets)', () => {
    expect(canonicalize({ ids: ['b', 'a'] })).not.toBe(canonicalize({ ids: ['a', 'b'] }));
  });

  it('handles unicode without normalization: composed and decomposed differ, bytes are stable', () => {
    const composed = canonicalize({ name: 'Ivan Golubić' }); // ć composed (U+0107)
    const decomposed = canonicalize({ name: 'Ivan Golubić' }); // c + combining acute
    expect(composed).not.toBe(decomposed);
    // Deterministic escaping per JSON.stringify: control chars escaped, the
    // rest passed through as-is.
    expect(canonicalize({ s: 'π 💾 \n  ' })).toBe('{"s":"π 💾 \\n  "}');
  });

  it('drops undefined properties and keeps null (jsonb has no undefined)', () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('pins the golden hash of a known payload — changing canonicalization breaks this test on purpose', () => {
    const payload: ReceiptChainPayload = {
      id: '11111111-2222-3333-4444-555555555555',
      source_type: 'user_note',
      source_id: 'abc',
      counts_json: {
        source: { type: 'user_note', id: 'abc' },
        requested_by: 'user-a',
        memory_ids: ['m1', 'm2'],
        memory_count: 2,
        point_ids: ['m1', 'm2'],
        object_keys: [],
        superseded_by_nulled: [],
        enumerated_at: '2026-07-04T12:00:00.000Z',
      },
      signed_at: '2026-07-04T12:00:01.000Z',
      confirmed_at: '2026-07-04T12:00:01.000Z',
      prev_hash: GENESIS_HASH,
    };
    expect(hashReceiptPayload(payload)).toBe(
      '5c5489ee6af99c1f75f81dce1baab846eee22dcf695fd0e031892eec2203c772',
    );
  });
});

describe('verifyChain (unit, real ed25519 keys)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

  const receipt = (id: string, prevHash: string): ConfirmedReceipt => {
    const payload: ReceiptChainPayload = {
      id,
      source_type: 'user_note',
      source_id: `note-${id}`,
      counts_json: { memory_ids: [id], memory_count: 1 },
      signed_at: '2026-07-04T12:00:00.000Z',
      confirmed_at: '2026-07-04T12:00:00.000Z',
      prev_hash: prevHash,
    };
    const hash = hashReceiptPayload(payload);
    const signature = sign(null, Buffer.from(hash, 'utf8'), privateKey).toString('base64');
    return { ...payload, hash, signature };
  };

  const buildChain = (): ConfirmedReceipt[] => {
    const r1 = receipt('r1', GENESIS_HASH);
    const r2 = receipt('r2', r1.hash);
    const r3 = receipt('r3', r2.hash);
    return [r3, r1, r2]; // storage order must not matter — linkage is the order
  };

  it('accepts an empty chain and a well-formed chain in any storage order', () => {
    expect(verifyChain([], publicKeyPem)).toMatchObject({ ok: true, verified: 0 });
    expect(verifyChain(buildChain(), publicKeyPem)).toMatchObject({ ok: true, verified: 3 });
  });

  it('rejects payload tampering (hash mismatch)', () => {
    const chain = buildChain();
    const victim = chain.find((r) => r.id === 'r2')!;
    victim.counts_json = { memory_ids: ['forged'], memory_count: 999 };
    const result = verifyChain(chain, publicKeyPem);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not match payload/);
  });

  it('rejects a re-hashed forgery (signature does not cover the forged hash)', () => {
    const chain = buildChain();
    const victim = chain.find((r) => r.id === 'r1')!;
    victim.counts_json = { memory_ids: ['forged'], memory_count: 999 };
    victim.hash = hashReceiptPayload(victim); // attacker recomputes the hash…
    const result = verifyChain(chain, publicKeyPem);
    expect(result.ok).toBe(false); // …but cannot re-sign it, and broke r2's linkage anyway
  });

  it('rejects a dropped receipt (broken linkage)', () => {
    const chain = buildChain().filter((r) => r.id !== 'r2');
    const result = verifyChain(chain, publicKeyPem);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/broken linkage|no receipt links/);
  });

  it('rejects a signature from a different key', () => {
    const other = generateKeyPairSync('ed25519');
    const chain = buildChain();
    const victim = chain.find((r) => r.id === 'r3')!;
    victim.signature = sign(null, Buffer.from(victim.hash, 'utf8'), other.privateKey).toString(
      'base64',
    );
    const result = verifyChain(chain, publicKeyPem);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/signature invalid/);
  });
});
