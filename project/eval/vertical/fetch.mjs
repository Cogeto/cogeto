#!/usr/bin/env node
/**
 * Fetch the vertical corpus originals (V2.3 item 6.4, issue A).
 *
 * The committed corpus is the labelled cases plus their verbatim text
 * excerpts. The ORIGINAL bytes are not committed: about 27 MB of third-party
 * PDFs do not belong in a source repository, and a recorded URL plus a
 * checksum is a stronger provenance claim than a copied file, because it can
 * be re-verified against the publisher.
 *
 * This script re-downloads every document in `documents.json` into
 * `originals/` (gitignored) and checks each SHA-256. Nothing in the eval
 * harness needs it: the golden-set suite and the reconciliation suite read the
 * committed excerpts. It exists so a reader can reproduce the corpus, and so
 * the diagnostic ingestion described in `README.md` can be repeated.
 *
 *   node project/eval/vertical/fetch.mjs            # fetch and verify all
 *   node project/eval/vertical/fetch.mjs mdr-2017-745-en rp2040-datasheet
 *
 * A document marked `byte_stable: false` is rebuilt in place by its publisher
 * (a datasheet with a build stamp, an HTML page with a session footer). A
 * checksum mismatch on one of those is a WARNING with the new checksum
 * printed, not a failure: the honest record is "this is what we read on the
 * retrieval date", not a pretence that a living page is frozen.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGINALS = path.join(HERE, 'originals');

const manifest = JSON.parse(await readFile(path.join(HERE, 'documents.json'), 'utf8'));
const wanted = new Set(process.argv.slice(2));
const documents = manifest.documents.filter((d) => wanted.size === 0 || wanted.has(d.id));

if (documents.length === 0) {
  console.error(
    `no documents matched. Known ids:\n  ${manifest.documents.map((d) => d.id).join('\n  ')}`,
  );
  process.exit(2);
}

await mkdir(ORIGINALS, { recursive: true });

let hardFailures = 0;
let warnings = 0;

for (const doc of documents) {
  const extension = doc.media_type === 'text/html' ? 'html' : 'pdf';
  const target = path.join(ORIGINALS, `${doc.id}.${extension}`);
  process.stdout.write(`${doc.id} ... `);
  let bytes;
  try {
    const response = await fetch(doc.url, {
      redirect: 'follow',
      headers: { 'user-agent': 'cogeto-eval-corpus/1.0 (+https://github.com/Cogeto/cogeto)' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.log(`FETCH FAILED (${error instanceof Error ? error.message : error})`);
    hardFailures += 1;
    continue;
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(target, bytes);
  if (sha256 === doc.sha256) {
    console.log(`ok (${bytes.length} bytes, checksum matches)`);
    continue;
  }
  if (doc.byte_stable === false) {
    console.log(
      `WARNING: checksum moved (expected ${doc.sha256}, got ${sha256}). ` +
        `This document is marked byte_stable:false: ${doc.byte_stable_note ?? 'the publisher rebuilds it in place'}. ` +
        `The committed excerpt describes the build retrieved on ${doc.retrieved}.`,
    );
    warnings += 1;
    continue;
  }
  console.log(`CHECKSUM MISMATCH (expected ${doc.sha256}, got ${sha256})`);
  hardFailures += 1;
}

console.log(
  `\n${documents.length} document(s), ${hardFailures} failure(s), ${warnings} warning(s) -> ${path.relative(process.cwd(), ORIGINALS)}`,
);
if (hardFailures > 0) process.exit(1);
