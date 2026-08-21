#!/usr/bin/env node
/**
 * The deployment-assets release artifact (hosted-provisioning task C).
 *
 * ONE tarball per release tag carries every file the operator installer needs
 * to stand a customer instance up, WITH the per-file checksum manifest inside
 * it. Two levels of verification, one shape for every consumer:
 *
 *   outer   sha256 of the tarball, published beside it as a second release
 *           asset and printed in the release notes, so it can be obtained
 *           without downloading the thing it verifies.
 *   inner   `project/infra/deploy/deploy-assets.sha256` (the manifest that
 *           already existed) travels INSIDE the tarball and every extracted
 *           file is checked against it before it is installed.
 *
 * The tarball also carries a `VERSION` file naming the release it belongs to.
 * The installer downloads by exact tag and then re-checks that marker, so the
 * version relationship is stated twice and a mismatch is a hard failure rather
 * than something resolved from a moving reference.
 *
 * Everything here is dependency-free and deterministic: the same bytes come
 * out of a given tree on a developer's machine and on the CI runner, so the
 * outer checksum can be reproduced by anyone who has the tag.
 *
 *   node scripts/ci/deploy-artifact.mjs build  --version X.Y.Z [--out-dir DIR]
 *   node scripts/ci/deploy-artifact.mjs verify --version X.Y.Z --file F [--checksum F.sha256]
 *
 * `build` writes the tarball and its `.sha256` and prints the digest.
 * `verify` is what the release workflow runs against its own output before it
 * publishes anything, and it fails the same way the installer would.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEPLOY_ASSETS, MANIFEST_PATH, buildManifest } from './deploy-assets-manifest.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The file naming the release the artifact belongs to, at the tarball root. */
export const VERSION_ENTRY = 'VERSION';

/** Every entry a well-formed artifact contains, in tar order. */
export const ARTIFACT_ENTRIES = [VERSION_ENTRY, MANIFEST_PATH, ...DEPLOY_ASSETS];

/** `cogeto-deploy-assets-1.9.0.tar.gz` — the version is part of the name. */
export function artifactName(version) {
  return `cogeto-deploy-assets-${version}.tar.gz`;
}

/** The outer-checksum asset published beside the tarball. */
export function checksumName(version) {
  return `${artifactName(version)}.sha256`;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ── A deterministic ustar writer ─────────────────────────────────────────────
//
// Hand-rolled rather than shelling out to tar: `tar` differs between GNU and
// BSD in exactly the fields that decide reproducibility (ordering, uid/gid,
// mtime, gzip header), and the artifact must hash the same everywhere. The
// format written here is plain ustar, which every system tar reads.

const BLOCK = 512;

const octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';

function tarHeader(name, size) {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`deploy artifact: entry name too long for ustar: ${name}`);
  }
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 8, 'ascii'); // mode
  header.write(octal(0, 8), 108, 8, 'ascii'); // uid
  header.write(octal(0, 8), 116, 8, 'ascii'); // gid
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii'); // mtime: fixed, for reproducibility
  header.write('        ', 148, 8, 'ascii'); // checksum field, spaces while summing
  header.write('0', 156, 1, 'ascii'); // typeflag: regular file
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

const pad = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** Pack `[name, bytes]` pairs into an uncompressed ustar archive. */
export function packTar(entries) {
  const parts = [];
  for (const [name, bytes] of entries) {
    parts.push(tarHeader(name, bytes.length), bytes, pad(bytes.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // two zero blocks end the archive
  return Buffer.concat(parts);
}

/** Read a ustar archive back into a Map of name → bytes (regular files only). */
export function unpackTar(tar) {
  const entries = new Map();
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, ''), 8);
    const typeflag = header.subarray(156, 157).toString('ascii');
    offset += BLOCK;
    if (typeflag === '0' || typeflag === '\0') {
      entries.set(name, tar.subarray(offset, offset + size));
    }
    offset += size + pad(size).length;
  }
  return entries;
}

// ── Build ────────────────────────────────────────────────────────────────────

/**
 * The artifact this tree implies, as bytes. The manifest is regenerated from
 * the same tree rather than copied, so an artifact can never be built around a
 * stale manifest — a drifted committed manifest is caught by `verify` below,
 * and by the operator-script spec, before it can reach a customer.
 */
export async function buildArtifact(version, repoRoot = REPO) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`deploy artifact: version must be X.Y.Z (got '${version}')`);
  }
  const manifest = await buildManifest(repoRoot);
  const committed = await readFile(path.join(repoRoot, MANIFEST_PATH), 'utf8').catch(() => '');
  if (committed !== manifest) {
    throw new Error(
      `${MANIFEST_PATH} is out of date with the deployment assets it covers.\n` +
        'Regenerate it: node scripts/ci/deploy-assets-manifest.mjs --write',
    );
  }
  const entries = [
    [VERSION_ENTRY, Buffer.from(`${version}\n`, 'utf8')],
    [MANIFEST_PATH, Buffer.from(manifest, 'utf8')],
  ];
  for (const asset of DEPLOY_ASSETS) {
    entries.push([asset, await readFile(path.join(repoRoot, asset))]);
  }
  // `mtime: 0` keeps the gzip header free of a timestamp, so the digest is a
  // function of the content and nothing else. The OS byte is normalised for
  // the same reason: zlib stamps the building platform there, which would give
  // a macOS build and a Linux build different digests for identical bytes.
  const gz = gzipSync(packTar(entries), { level: 9, mtime: 0 });
  gz[9] = 0x03; // Unix
  return { name: artifactName(version), bytes: gz, sha256: sha256(gz) };
}

// ── Verify ───────────────────────────────────────────────────────────────────

/**
 * The reasons an artifact is rejected. They are distinct because the caller's
 * next move differs: a missing artifact means that release does not carry one,
 * an outer mismatch means the download is not what was published, a per-file
 * mismatch means the tarball's own contents disagree with its manifest.
 */
export class ArtifactError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Everything the installer checks, in the installer's order, over bytes in
 * memory. The release workflow runs this against its own output so a malformed
 * artifact fails the release instead of a customer's install.
 */
export function verifyArtifact(bytes, version, expectedSha) {
  const actual = sha256(bytes);
  if (expectedSha && actual !== expectedSha) {
    throw new ArtifactError(
      'outer-checksum-mismatch',
      `outer checksum mismatch: expected ${expectedSha}, got ${actual}`,
    );
  }
  let entries;
  try {
    entries = unpackTar(gunzipSync(bytes));
  } catch (cause) {
    throw new ArtifactError('malformed', `the artifact is not a readable gzipped tar: ${cause}`);
  }
  const stamped = entries.get(VERSION_ENTRY)?.toString('utf8').trim();
  if (stamped !== version) {
    throw new ArtifactError(
      'version-mismatch',
      `the artifact is stamped '${stamped ?? '(no VERSION entry)'}' but ${version} was requested`,
    );
  }
  const manifest = entries.get(MANIFEST_PATH)?.toString('utf8');
  if (!manifest) {
    throw new ArtifactError('malformed', `the artifact carries no ${MANIFEST_PATH}`);
  }
  const expected = new Map(
    manifest
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/))
      .map(([hash, file]) => [file, hash]),
  );
  for (const asset of DEPLOY_ASSETS) {
    const bytesOf = entries.get(asset);
    if (!bytesOf) {
      throw new ArtifactError(
        'incomplete',
        `the artifact is missing ${asset}, which the installer fetches`,
      );
    }
    const want = expected.get(asset);
    if (!want) {
      throw new ArtifactError('incomplete', `${MANIFEST_PATH} has no entry for ${asset}`);
    }
    const got = sha256(bytesOf);
    if (got !== want) {
      throw new ArtifactError('file-checksum-mismatch', `${asset}: expected ${want}, got ${got}`);
    }
  }
  const unexpected = [...entries.keys()].filter((name) => !ARTIFACT_ENTRIES.includes(name));
  if (unexpected.length > 0) {
    throw new ArtifactError('malformed', `the artifact carries unexpected entries: ${unexpected}`);
  }
  return { sha256: actual, entries: [...entries.keys()] };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const command = process.argv[2];
  const version = flag('version');
  if (!version) {
    console.error(
      'usage: deploy-artifact.mjs <build|verify> --version X.Y.Z [--out-dir D] [--file F]',
    );
    process.exit(2);
  }
  if (command === 'build') {
    const outDir = flag('out-dir') ?? process.cwd();
    const { name, bytes, sha256: digest } = await buildArtifact(version);
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, name), bytes);
    await writeFile(path.join(outDir, checksumName(version)), `${digest}  ${name}\n`, 'utf8');
    // Verify what was just written, the way the installer will: a build step
    // that cannot fail is not a guarantee.
    verifyArtifact(bytes, version, digest);
    console.log(`${name}  ${bytes.length} bytes  ${ARTIFACT_ENTRIES.length} entries`);
    console.log(`sha256=${digest}`);
    return;
  }
  if (command === 'verify') {
    const file = flag('file') ?? path.join(process.cwd(), artifactName(version));
    const checksumFile = flag('checksum') ?? `${file}.sha256`;
    const bytes = await readFile(file);
    const published = await readFile(checksumFile, 'utf8').catch(() => '');
    const [digest, named] = published.trim().split(/\s+/);
    if (!/^[0-9a-f]{64}$/.test(digest ?? '')) {
      console.error(`${checksumFile} does not carry a sha256 for ${artifactName(version)}`);
      process.exit(1);
    }
    if (named !== artifactName(version)) {
      console.error(`${checksumFile} names '${named}', not ${artifactName(version)}`);
      process.exit(1);
    }
    try {
      const { entries } = verifyArtifact(bytes, version, digest);
      console.log(`${path.basename(file)} verified: ${entries.length} entries, sha256=${digest}`);
    } catch (error) {
      console.error(`${path.basename(file)} REJECTED (${error.reason}): ${error.message}`);
      process.exit(1);
    }
    return;
  }
  console.error(`unknown command '${command ?? ''}' (build|verify)`);
  process.exit(2);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
