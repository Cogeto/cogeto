import { PASSPORT_VERSION } from '@cogeto/shared';
import { createZip } from './zip';
import type { ZipEntry } from './zip';
import {
  documentBytes,
  PASSPORT_PATHS,
  sha256Hex,
  type Manifest,
  type MemoryExport,
  type ReceiptExport,
  type TaskExport,
} from './passport-format';

export interface PassportSubject {
  userId: string;
  displayName: string | null;
}

export interface PassportInput {
  subject: PassportSubject;
  memories: MemoryExport[];
  tasks: TaskExport[];
  receipts: ReceiptExport[];
  /** Original bytes to include under `attachments/`, when include_originals. */
  attachments: ZipEntry[];
  instancePublicKeyPem: string;
  includeOriginals: boolean;
  generatedAt: Date;
  /** ed25519 signer over raw bytes → base64 (the worker's instance signer). */
  sign: (bytes: Buffer) => string;
}

export interface AssembledPassport {
  zip: Buffer;
  manifest: Manifest;
  sizeBytes: number;
}

const README = `Cogeto Memory Passport
======================

This is a complete, portable export of your data from Cogeto, in an open,
documented, versioned format. You are not locked in.

Read it:
  manifest.json    index of every document with a SHA-256 hash of each, the
                   instance public key, and how the manifest is signed
  manifest.json.sig  detached ed25519 signature over manifest.json
  memories.json    every fact, with status, scope, provenance and the full
                   validity/supersession history (not just the current state)
  tasks.json       tasks derived from your memories, with conditions and status
  receipts.json    your deletion receipts, still independently verifiable
  attachments/     original files, if you chose to include them

Verify it (using only this archive and the published schema):
  1. Check manifest.json.sig against manifest.json using instance.public_key_pem.
  2. For each entry in manifest.documents, SHA-256 the file and compare.
  3. Verify each receipt in receipts.json against its hash chain and the key.

The format is documented at docs/passport-schema/ in the Cogeto repository,
version ${PASSPORT_VERSION}.
`;

/**
 * Assemble the Passport artifact (§B.5) from already-gated data — pure format,
 * hashing, signing and zipping; no I/O, no gates (the executor did the gated
 * reads). The manifest lists every document with its SHA-256 so the archive is
 * self-checking, and is signed with the instance key so its integrity verifies
 * exactly like a deletion receipt.
 */
export function assemblePassport(input: PassportInput): AssembledPassport {
  const memoriesBytes = documentBytes({
    passport_version: PASSPORT_VERSION,
    count: input.memories.length,
    memories: input.memories,
  });
  const tasksBytes = documentBytes({
    passport_version: PASSPORT_VERSION,
    count: input.tasks.length,
    tasks: input.tasks,
  });
  const receiptsBytes = documentBytes({
    passport_version: PASSPORT_VERSION,
    count: input.receipts.length,
    instance_public_key_pem: input.instancePublicKeyPem,
    receipts: input.receipts,
  });
  const readmeBytes = Buffer.from(README, 'utf8');

  // Every non-manifest document, with its content hash (attachments included).
  const documentEntries: ZipEntry[] = [
    { path: PASSPORT_PATHS.memories, data: memoriesBytes },
    { path: PASSPORT_PATHS.tasks, data: tasksBytes },
    { path: PASSPORT_PATHS.receipts, data: receiptsBytes },
    { path: PASSPORT_PATHS.readme, data: readmeBytes },
    ...input.attachments,
  ];
  const documents = documentEntries.map((entry) => ({
    path: entry.path,
    sha256: sha256Hex(entry.data),
    bytes: entry.data.length,
  }));

  const manifest: Manifest = {
    passport_version: PASSPORT_VERSION,
    generated_at: input.generatedAt.toISOString(),
    subject: { user_id: input.subject.userId, display_name: input.subject.displayName },
    instance: {
      public_key_pem: input.instancePublicKeyPem,
      signature_algorithm: 'ed25519',
      signature_file: PASSPORT_PATHS.manifestSig,
    },
    options: { include_originals: input.includeOriginals },
    counts: {
      memories: input.memories.length,
      tasks: input.tasks.length,
      receipts: input.receipts.length,
      attachments: input.attachments.length,
    },
    documents,
  };

  const manifestBytes = documentBytes(manifest);
  const signature = input.sign(manifestBytes); // base64 ed25519 over manifest.json
  const sigBytes = Buffer.from(signature, 'utf8');

  const zip = createZip(
    [
      { path: PASSPORT_PATHS.manifest, data: manifestBytes },
      { path: PASSPORT_PATHS.manifestSig, data: sigBytes },
      ...documentEntries,
    ],
    input.generatedAt,
  );
  return { zip, manifest, sizeBytes: zip.length };
}
