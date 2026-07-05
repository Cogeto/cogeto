import { createHash } from 'node:crypto';
import { verifyWithPublicKey } from '../../infrastructure/index';

/**
 * The deletion receipt hash chain (§B.1, decision 0008) — pure functions only.
 *
 * Each confirmed receipt's canonical payload is SHA-256 hashed with the
 * previous confirmed receipt's hash inside it (prev_hash), forming a
 * tamper-evident log signed with the instance ed25519 key. The chain's ORDER
 * IS THE LINKAGE: verification walks prev_hash pointers from the genesis
 * constant, never timestamps — clock skew cannot fork or reorder the chain
 * (confirmation itself is serialized by an advisory lock, see deletion-saga).
 *
 * Canonicalization contract (a bug here is a broken chain later):
 * - Object keys sorted lexicographically (code point order) at every depth.
 * - Arrays keep their order.
 * - Timestamps are ISO-8601 UTC strings with milliseconds (Date#toISOString).
 * - Strings escaped per JSON.stringify (deterministic across JS engines);
 *   no unicode normalization — the bytes the receipt stored are the bytes
 *   that get hashed.
 * - The hash is SHA-256 over the UTF-8 bytes of the canonical JSON string.
 */

/** Genesis: prev_hash of the first confirmed receipt on an instance. */
export const GENESIS_HASH = 'cogeto:deletion-receipt-chain:genesis';

/** The receipt fields covered by the hash and signature. */
export interface ReceiptChainPayload {
  id: string;
  source_type: string;
  source_id: string;
  counts_json: unknown;
  signed_at: string;
  confirmed_at: string;
  prev_hash: string;
}

/** The stored shape verifyChain consumes (a projection of deletion_receipt). */
export interface ConfirmedReceipt extends ReceiptChainPayload {
  hash: string;
  signature: string;
}

/** Deterministic JSON: sorted object keys at every depth, arrays in order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

export function hashReceiptPayload(payload: ReceiptChainPayload): string {
  return createHash('sha256')
    .update(Buffer.from(canonicalize(payload), 'utf8'))
    .digest('hex');
}

export interface ChainVerification {
  ok: boolean;
  /** Confirmed receipts that verified, in chain order. */
  verified: number;
  /** Total confirmed receipts inspected. */
  confirmed: number;
  /** First failure, when !ok. */
  error?: string;
}

/**
 * Walks the full chain: exactly one genesis, every link resolvable, every
 * stored hash recomputable from the stored payload, every signature valid.
 * Any tampering with a stored payload, hash, or signature breaks it.
 */
export function verifyChain(receipts: ConfirmedReceipt[], publicKeyPem: string): ChainVerification {
  const result = (ok: boolean, verified: number, error?: string): ChainVerification => ({
    ok,
    verified,
    confirmed: receipts.length,
    ...(error ? { error } : {}),
  });
  if (receipts.length === 0) return result(true, 0);

  const byPrev = new Map<string, ConfirmedReceipt>();
  for (const receipt of receipts) {
    if (byPrev.has(receipt.prev_hash)) {
      return result(false, 0, `chain forks: two receipts share prev_hash ${receipt.prev_hash}`);
    }
    byPrev.set(receipt.prev_hash, receipt);
  }

  let expectedPrev = GENESIS_HASH;
  let verified = 0;
  while (verified < receipts.length) {
    const receipt = byPrev.get(expectedPrev);
    if (!receipt) {
      return result(false, verified, `broken linkage: no receipt links to ${expectedPrev}`);
    }
    const recomputed = hashReceiptPayload({
      id: receipt.id,
      source_type: receipt.source_type,
      source_id: receipt.source_id,
      counts_json: receipt.counts_json,
      signed_at: receipt.signed_at,
      confirmed_at: receipt.confirmed_at,
      prev_hash: receipt.prev_hash,
    });
    if (recomputed !== receipt.hash) {
      return result(false, verified, `receipt ${receipt.id}: stored hash does not match payload`);
    }
    if (!verifyWithPublicKey(publicKeyPem, receipt.hash, receipt.signature)) {
      return result(false, verified, `receipt ${receipt.id}: signature invalid`);
    }
    expectedPrev = receipt.hash;
    verified += 1;
  }
  return result(true, verified);
}
