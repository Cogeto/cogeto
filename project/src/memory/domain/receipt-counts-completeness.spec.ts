import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureInstanceKeys, loadInstanceSigner } from '../../infrastructure/index';
import type { InstanceSigner } from '../../infrastructure/index';
import { canonicalize, GENESIS_HASH, hashReceiptPayload, verifyChain } from './receipt-chain';
import type { ConfirmedReceipt } from './receipt-chain';
import { countedRemovals, parseReceiptCounts } from '../deletion-saga';
import type { ReceiptCounts } from '../deletion-saga';

/**
 * receipt_counts_completeness (issue #635).
 *
 * The saga registers sixteen `DerivedCascade` implementations and the receipt
 * named nine of them. Six more are counted now, two of them content-bearing.
 * Two properties have to hold at once and this file pins both:
 *
 *  1. **Nothing historical moves.** Every field is additive and optional and
 *     is written only when non-zero, so a receipt signed before the change
 *     parses, canonicalizes and verifies to exactly the bytes it always did.
 *     The chain hashes the STORED payload, so a single changed byte anywhere
 *     in this schema would break every instance's chain at once.
 *
 *  2. **The SEC-30 guard follows the schema.** `countedRemovals` reads the
 *     payload back instead of restating which cascades exist, so a deletion
 *     that removes only a newly counted class can no longer report "nothing
 *     erasable derived from this source" and skip the receipt.
 */

/** A `counts_json` exactly as the saga produced it before issue #635. */
const PRE_CHANGE_COUNTS = {
  source: { type: 'file', id: 'org-1/user-ana/private/file-9d3e' },
  requested_by: 'user-ana',
  memory_ids: ['11111111-1111-4111-8111-111111111111'],
  memory_count: 1,
  chat_messages_redacted: 0,
  reply_drafts_redacted: 0,
  point_ids: ['11111111-1111-4111-8111-111111111111'],
  object_keys: ['org-1/user-ana/private/file-9d3e'],
  superseded_by_nulled: [],
  enumerated_at: '2026-06-11T08:02:19.117Z',
};

/** The canonical string of the payload above, computed before this change.
 * A pinned constant, never re-derived: if it moves, so does every receipt
 * ever signed on every instance. */
const PRE_CHANGE_CANONICAL =
  '{"chat_messages_redacted":0,' +
  '"enumerated_at":"2026-06-11T08:02:19.117Z",' +
  '"memory_count":1,' +
  '"memory_ids":["11111111-1111-4111-8111-111111111111"],' +
  '"object_keys":["org-1/user-ana/private/file-9d3e"],' +
  '"point_ids":["11111111-1111-4111-8111-111111111111"],' +
  '"reply_drafts_redacted":0,' +
  '"requested_by":"user-ana",' +
  '"source":{"id":"org-1/user-ana/private/file-9d3e","type":"file"},' +
  '"superseded_by_nulled":[]}';

describe('receipt_counts_completeness', () => {
  let signer: InstanceSigner;
  let publicKeyPem: string;

  beforeAll(async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'receipt-counts-635-'));
    await ensureInstanceKeys(keyDir);
    signer = await loadInstanceSigner(keyDir);
    publicKeyPem = signer.publicKeyPem;
  });

  const sign = (bytes: Buffer): string => signer.sign(bytes);

  it('a receipt written before the new counts existed canonicalizes to the same bytes', () => {
    expect(canonicalize(PRE_CHANGE_COUNTS)).toBe(PRE_CHANGE_CANONICAL);
  });

  it('a historical receipt still parses, hashes and verifies under the widened schema', () => {
    const payload = {
      id: '33333333-3333-4333-8333-333333333333',
      source_type: 'file',
      source_id: 'org-1/user-ana/private/file-9d3e',
      counts_json: PRE_CHANGE_COUNTS,
      signed_at: '2026-06-11T08:02:20.004Z',
      confirmed_at: '2026-06-11T08:02:20.004Z',
      prev_hash: GENESIS_HASH,
    };
    // The executor re-parses stored receipts on every retry, so a schema that
    // rejected a historical payload would break replay, not merely reads.
    const parsed = parseReceiptCounts(PRE_CHANGE_COUNTS);
    expect(parsed.source_contexts_removed).toBeUndefined();
    expect(parsed.confluence_pages_removed).toBeUndefined();

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

  it('a chain mixing a pre-change and a fully counted receipt verifies end to end', () => {
    const historical = {
      id: '44444444-4444-4444-8444-444444444444',
      source_type: 'file',
      source_id: 'org-1/user-ana/private/file-old',
      counts_json: PRE_CHANGE_COUNTS,
      signed_at: '2026-06-11T08:02:20.004Z',
      confirmed_at: '2026-06-11T08:02:20.004Z',
      prev_hash: GENESIS_HASH,
    };
    const historicalHash = hashReceiptPayload(historical);

    const current = {
      id: '55555555-5555-4555-8555-555555555555',
      source_type: 'file',
      source_id: 'org-1/user-ana/private/file-new',
      counts_json: {
        ...PRE_CHANGE_COUNTS,
        source: { type: 'file', id: 'org-1/user-ana/private/file-new' },
        source_contexts_removed: 1,
        confluence_pages_removed: 1,
        source_revisions_removed: 2,
        extraction_refusals_removed: 1,
        ingestion_progress_removed: 1,
        project_assignments_released: 1,
      },
      signed_at: '2026-08-16T10:00:00.000Z',
      confirmed_at: '2026-08-16T10:00:00.000Z',
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

    const parsed = parseReceiptCounts(current.counts_json);
    expect(parsed.source_contexts_removed).toBe(1);
    expect(parsed.confluence_pages_removed).toBe(1);
    expect(parsed.source_revisions_removed).toBe(2);
    expect(parsed.extraction_refusals_removed).toBe(1);
    expect(parsed.ingestion_progress_removed).toBe(1);
    expect(parsed.project_assignments_released).toBe(1);
  });

  describe('the SEC-30 guard reads the schema instead of restating it', () => {
    /** A payload with nothing removed: the genuinely vacuous deletion. */
    const empty: ReceiptCounts = {
      source: { type: 'user_note', id: 'note-1' },
      requested_by: 'user-ana',
      memory_ids: [],
      memory_count: 0,
      chat_messages_redacted: 0,
      reply_drafts_redacted: 0,
      point_ids: [],
      object_keys: [],
      superseded_by_nulled: [],
      enumerated_at: '2026-08-16T10:00:00.000Z',
    };

    it('counts nothing when nothing was removed', () => {
      expect(countedRemovals(empty)).toBe(0);
    });

    it.each([
      'file_read_reports_removed',
      'chat_attachments_removed',
      'connector_items_erased',
      'source_contexts_removed',
      'confluence_pages_removed',
      'source_revisions_removed',
      'extraction_refusals_removed',
      'ingestion_progress_removed',
      'project_assignments_released',
    ] as const)(
      'counts a deletion whose only effect was %s, which used to report nothing erased',
      (field) => {
        // Each of these was absent from the old disjunction. A deletion that
        // removed only this class produced `source.deleted_empty` in the audit
        // trail and no receipt at all.
        expect(countedRemovals({ ...empty, [field]: 1 })).toBe(1);
      },
    );

    it('still counts the classes the old disjunction did name', () => {
      expect(countedRemovals({ ...empty, suppressed_facts_removed: 3 })).toBe(3);
      expect(countedRemovals({ ...empty, passport_exports_expired: 1 })).toBe(1);
      expect(countedRemovals({ ...empty, findings_reports_expired: 2 })).toBe(2);
      expect(countedRemovals({ ...empty, chat_messages_removed: 4 })).toBe(4);
    });

    it('counts a historical receipt that carries the retired tasks_removed field', () => {
      // The field is permanently optional and never written again; the guard
      // must still treat such a payload as a real erasure.
      expect(countedRemovals({ ...empty, tasks_removed: 2 })).toBe(2);
    });
  });
});
