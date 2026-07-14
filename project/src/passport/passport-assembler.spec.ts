import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PASSPORT_VERSION } from '@cogeto/shared';
import { canonicalize, GENESIS_HASH, verifyChain, type ConfirmedReceipt } from '../memory/index';
import { verifyWithPublicKey } from '../infrastructure/index';
import { assemblePassport } from './passport-assembler';
import type { PassportInput } from './passport-assembler';
import { readZip } from './zip';
import {
  manifestSchema,
  memoriesDocSchema,
  receiptsDocSchema,
  sha256Hex,
  tasksDocSchema,
  PASSPORT_PATHS,
  type MemoryExport,
  type TaskExport,
} from './passport-format';

/**
 * The Passport assembler is pure — format, hashing, signing, zipping — so these
 * checks need no database: they assemble a real archive, read it back, and prove
 * it is self-describing and verifiable exactly as a third party would
 * (passport_schema_valid, passport_manifest_hashes, receipts_verifiable_in_export
 * + the manifest signature), using a real ed25519 keypair generated in-test.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
const sign = (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64');

const memory = (over: Partial<MemoryExport> = {}): MemoryExport => ({
  id: 'm1',
  content: 'Atlas costs 100 EUR.',
  status: 'replaced',
  scope: 'private',
  sensitive: false,
  owner_id: 'ana',
  owned_by_me: true,
  entities: [],
  subject_entity: 'Atlas',
  kind: 'fact',
  valid_from: '2026-01-01T00:00:00.000Z',
  valid_until: '2026-04-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: null,
  superseded_by: 'm2',
  temporal_unresolved: [],
  provenance: {
    source_type: 'user_note',
    source_id: 'n1',
    context: null,
    file: null,
    attachment_path: null,
  },
  ...over,
});

const task: TaskExport = {
  id: 't1',
  title: 'Send the proposal',
  status: 'open',
  condition_text: null,
  due: null,
  dormant: false,
  from_uncertain: false,
  derived_from_memory_id: 'm2',
  scope: 'private',
  created_at: '2026-07-14T00:00:00.000Z',
  updated_at: null,
};

/** A genuinely-signed single-link receipt chain (genesis → this receipt). */
function signedReceipt(): ConfirmedReceipt {
  const payload = {
    id: 'r1',
    source_type: 'user_note',
    source_id: 'n-old',
    counts_json: {
      requested_by: 'ana',
      enumerated_at: '2026-06-30T12:00:00.000Z',
      memory_count: 1,
      object_keys: [],
    },
    signed_at: '2026-06-30T12:00:03.000Z',
    confirmed_at: '2026-06-30T12:00:03.000Z',
    prev_hash: GENESIS_HASH,
  };
  // Same hash the deletion-receipt chain computes: sha256 over canonical JSON.
  const hash = sha256Hex(Buffer.from(canonicalize(payload), 'utf8'));
  return { ...payload, hash, signature: sign(Buffer.from(hash, 'utf8')) };
}

function assemble(over: Partial<PassportInput> = {}) {
  const input: PassportInput = {
    subject: { userId: 'ana', displayName: 'Ana Kovač' },
    memories: [
      memory({ id: 'm1' }),
      memory({ id: 'm2', status: 'user_approved', superseded_by: null, valid_until: null }),
    ],
    tasks: [task],
    receipts: [signedReceipt()],
    attachments: [],
    instancePublicKeyPem: publicKeyPem,
    includeOriginals: false,
    generatedAt: new Date('2026-07-14T12:00:00.000Z'),
    sign,
    ...over,
  };
  const { zip } = assemblePassport(input);
  const entries = new Map(readZip(zip).map((e) => [e.path, e.data]));
  return { zip, entries };
}

describe('passport assembler (pure)', () => {
  it('passport_schema_valid: every generated document validates against the published contract', () => {
    const { entries } = assemble();
    expect(
      memoriesDocSchema.safeParse(JSON.parse(entries.get(PASSPORT_PATHS.memories)!.toString()))
        .success,
    ).toBe(true);
    expect(
      tasksDocSchema.safeParse(JSON.parse(entries.get(PASSPORT_PATHS.tasks)!.toString())).success,
    ).toBe(true);
    expect(
      receiptsDocSchema.safeParse(JSON.parse(entries.get(PASSPORT_PATHS.receipts)!.toString()))
        .success,
    ).toBe(true);
    const manifest = JSON.parse(entries.get(PASSPORT_PATHS.manifest)!.toString());
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.passport_version).toBe(PASSPORT_VERSION);
  });

  it('passport_manifest_hashes: each document matches its manifest hash and byte length', () => {
    const { entries } = assemble();
    const manifest = JSON.parse(entries.get(PASSPORT_PATHS.manifest)!.toString());
    expect(manifest.documents.length).toBeGreaterThanOrEqual(4); // memories, tasks, receipts, README
    for (const doc of manifest.documents) {
      const bytes = entries.get(doc.path);
      expect(bytes, `document ${doc.path} present`).toBeDefined();
      expect(sha256Hex(bytes!)).toBe(doc.sha256);
      expect(bytes!.length).toBe(doc.bytes);
    }
    // Tampering with a document breaks its recorded hash.
    const tampered = Buffer.from('{"passport_version":"1.0","count":0,"tasks":[]}\n');
    const tasksDoc = manifest.documents.find(
      (d: { path: string }) => d.path === PASSPORT_PATHS.tasks,
    );
    expect(sha256Hex(tampered)).not.toBe(tasksDoc.sha256);
  });

  it('the manifest is signed and verifies against the included public key', () => {
    const { entries } = assemble();
    const manifestBytes = entries.get(PASSPORT_PATHS.manifest)!;
    const sig = entries.get(PASSPORT_PATHS.manifestSig)!.toString('utf8');
    const manifest = JSON.parse(manifestBytes.toString());
    expect(verifyWithPublicKey(manifest.instance.public_key_pem, manifestBytes, sig)).toBe(true);
    // A one-byte change to the manifest invalidates the signature.
    const mutated = Buffer.from(manifestBytes);
    mutated[mutated.length - 2] ^= 0x01;
    expect(verifyWithPublicKey(manifest.instance.public_key_pem, mutated, sig)).toBe(false);
  });

  it('receipts_verifiable_in_export: an exported receipt verifies against its chain and key', () => {
    const { entries } = assemble();
    const doc = JSON.parse(entries.get(PASSPORT_PATHS.receipts)!.toString());
    const receipts: ConfirmedReceipt[] = doc.receipts;
    const result = verifyChain(receipts, doc.instance_public_key_pem);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(1);
    // A tampered receipt payload breaks verification.
    const broken = [{ ...receipts[0]!, source_id: 'n-changed' }];
    expect(verifyChain(broken, doc.instance_public_key_pem).ok).toBe(false);
  });

  it('includes attachments in the manifest with their own hash', () => {
    const data = Buffer.from('PDF-BYTES');
    const { entries } = assemble({
      includeOriginals: true,
      attachments: [{ path: `${PASSPORT_PATHS.attachmentsDir}/files/file-x.pdf`, data }],
    });
    const manifest = JSON.parse(entries.get(PASSPORT_PATHS.manifest)!.toString());
    const att = manifest.documents.find((d: { path: string }) => d.path.startsWith('attachments/'));
    expect(att).toBeDefined();
    expect(att.sha256).toBe(sha256Hex(data));
    expect(manifest.counts.attachments).toBe(1);
    expect(manifest.options.include_originals).toBe(true);
  });
});
