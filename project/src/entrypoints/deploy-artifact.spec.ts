import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs CI scripts, no type declarations by design
import { DEPLOY_ASSETS, MANIFEST_PATH } from '../../../scripts/ci/deploy-assets-manifest.mjs';
// @ts-expect-error -- plain .mjs CI scripts, no type declarations by design
import {
  ARTIFACT_ENTRIES,
  ArtifactError,
  VERSION_ENTRY,
  artifactName,
  buildArtifact,
  checksumName,
  packTar,
  unpackTar,
  verifyArtifact,
} from '../../../scripts/ci/deploy-artifact.mjs';

/**
 * The deployment-assets release artifact (hosted-provisioning task C).
 *
 * ONE tarball per release tag carries the files that define a customer stack,
 * with the per-file checksum manifest inside it. The operator installer and
 * the hosting platform's version-upgrade automation both consume it and
 * nothing else, which makes two things load-bearing and therefore asserted
 * here rather than left to review:
 *
 *   • COMPLETENESS. Adding a deployment asset without adding it to the
 *     artifact must fail the build now, not break a customer's install months
 *     later. `DEPLOY_ASSETS` is the one list, and the artifact is checked
 *     against it entry by entry.
 *   • DISTINGUISHABLE FAILURES. A missing artifact, an outer checksum
 *     mismatch, a per-file mismatch and a wrong-version artifact are four
 *     different problems with four different responses, so the verifier gives
 *     each its own reason instead of one "invalid artifact".
 */
const SRC = process.cwd();
const REPO = path.resolve(SRC, '../..');
const VERSION = '9.9.9';
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const entriesOf = (bytes: Buffer): Map<string, Buffer> => unpackTar(gunzipSync(bytes));

/** Repack a built artifact with one entry replaced — the tampering cases. */
function repack(entries: Map<string, Buffer>): Buffer {
  const gz = gzipSync(packTar([...entries.entries()]), { level: 9, mtime: 0 });
  gz[9] = 0x03;
  return gz;
}

describe('deployment-assets release artifact', () => {
  it('carries every asset the installer expects, the manifest, and a VERSION marker', async () => {
    const { name, bytes } = await buildArtifact(VERSION, REPO);
    expect(name).toBe(`cogeto-deploy-assets-${VERSION}.tar.gz`);
    const entries = entriesOf(bytes);
    // Exactly the expected set: nothing missing, nothing extra.
    expect([...entries.keys()].sort()).toEqual([...ARTIFACT_ENTRIES].sort());
    for (const asset of DEPLOY_ASSETS) {
      expect(entries.has(asset), `${asset} is not in the artifact`).toBe(true);
      // The bytes are the working tree's, not a re-rendering of them.
      expect(entries.get(asset)).toEqual(readFileSync(path.join(REPO, asset)));
    }
    expect(entries.get(VERSION_ENTRY)?.toString('utf8').trim()).toBe(VERSION);
    // The per-file manifest travels INSIDE, and is the committed one.
    expect(entries.get(MANIFEST_PATH)?.toString('utf8')).toBe(
      readFileSync(path.join(REPO, MANIFEST_PATH), 'utf8'),
    );
  });

  it('is reproducible: the same tree yields the same bytes and the same outer checksum', async () => {
    const first = await buildArtifact(VERSION, REPO);
    const second = await buildArtifact(VERSION, REPO);
    expect(second.bytes).toEqual(first.bytes);
    expect(second.sha256).toBe(first.sha256);
    expect(first.sha256).toBe(sha256(first.bytes));
  });

  it('every file inside matches the manifest inside', async () => {
    const { bytes } = await buildArtifact(VERSION, REPO);
    const entries = entriesOf(bytes);
    const manifest = entries.get(MANIFEST_PATH)!.toString('utf8');
    const listed = manifest
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/) as [string, string]);
    expect(listed.map(([, file]) => file).sort()).toEqual([...DEPLOY_ASSETS].sort());
    for (const [hash, file] of listed) {
      expect(sha256(entries.get(file)!), `${file}`).toBe(hash);
    }
  });

  it('verifies clean, and names the outer checksum asset after the tarball', async () => {
    const { bytes, sha256: digest } = await buildArtifact(VERSION, REPO);
    expect(checksumName(VERSION)).toBe(`${artifactName(VERSION)}.sha256`);
    expect(verifyArtifact(bytes, VERSION, digest).entries.sort()).toEqual(
      [...ARTIFACT_ENTRIES].sort(),
    );
  });

  describe('rejection reasons are distinct, because the response to each differs', () => {
    it('an outer checksum mismatch is caught before the tarball is opened', async () => {
      const { bytes } = await buildArtifact(VERSION, REPO);
      const wrong = sha256(Buffer.concat([bytes, Buffer.from('x')]));
      expect(() => verifyArtifact(bytes, VERSION, wrong)).toThrow(ArtifactError);
      try {
        verifyArtifact(bytes, VERSION, wrong);
      } catch (error) {
        expect((error as { reason: string }).reason).toBe('outer-checksum-mismatch');
      }
    });

    it('a file altered inside the tarball is caught against the manifest inside', async () => {
      const { bytes } = await buildArtifact(VERSION, REPO);
      const entries = entriesOf(bytes);
      const target = DEPLOY_ASSETS[1]!;
      entries.set(target, Buffer.concat([entries.get(target)!, Buffer.from('\n# injected\n')]));
      const tampered = repack(entries);
      // The outer checksum of the tampered tarball is its own, so this is
      // exactly the case the inner manifest exists for.
      try {
        verifyArtifact(tampered, VERSION, sha256(tampered));
        expect.unreachable('a tampered file must be rejected');
      } catch (error) {
        expect((error as { reason: string }).reason).toBe('file-checksum-mismatch');
        expect((error as Error).message).toContain(target);
      }
    });

    it('an artifact stamped with another version is rejected, not installed', async () => {
      const { bytes } = await buildArtifact(VERSION, REPO);
      const entries = entriesOf(bytes);
      entries.set(VERSION_ENTRY, Buffer.from('1.2.3\n'));
      const other = repack(entries);
      try {
        verifyArtifact(other, VERSION, sha256(other));
        expect.unreachable('a version mismatch must be rejected');
      } catch (error) {
        expect((error as { reason: string }).reason).toBe('version-mismatch');
      }
    });

    it('an artifact missing one of the assets the installer needs is incomplete, not merely odd', async () => {
      const { bytes } = await buildArtifact(VERSION, REPO);
      const entries = entriesOf(bytes);
      entries.delete(DEPLOY_ASSETS[0]!);
      const short = repack(entries);
      try {
        verifyArtifact(short, VERSION, sha256(short));
        expect.unreachable('a missing asset must be rejected');
      } catch (error) {
        expect((error as { reason: string }).reason).toBe('incomplete');
      }
    });

    it('an artifact carrying no manifest, or unexpected entries, is malformed', async () => {
      const { bytes } = await buildArtifact(VERSION, REPO);
      const withoutManifest = entriesOf(bytes);
      withoutManifest.delete(MANIFEST_PATH);
      const stray = entriesOf(bytes);
      stray.set('surprise.sh', Buffer.from('#!/bin/sh\n'));
      for (const variant of [repack(withoutManifest), repack(stray)]) {
        try {
          verifyArtifact(variant, VERSION, sha256(variant));
          expect.unreachable('a malformed artifact must be rejected');
        } catch (error) {
          expect((error as { reason: string }).reason).toBe('malformed');
        }
      }
    });
  });

  it('the installer and the builder agree on the artifact name', () => {
    const script = readFileSync(path.join(REPO, 'scripts', 'operator', 'cogeto'), 'utf8');
    // The one place the name is spelled in bash must produce what the builder
    // publishes; a drift here is an install that 404s on every release.
    expect(script).toContain("printf 'cogeto-deploy-assets-%s.tar.gz'");
    expect(artifactName('1.2.3')).toBe('cogeto-deploy-assets-1.2.3.tar.gz');
  });

  it('the release workflow builds it, verifies it, attaches it, and proves it is attached', () => {
    const release = readFileSync(path.join(REPO, '.github/workflows/release.yml'), 'utf8');
    expect(release).toContain('deploy-artifact.mjs build --version');
    expect(release).toContain('deploy-artifact.mjs verify --version');
    // Attached to the release itself, both files.
    expect(release).toContain('"dist-assets/${ASSET_NAME}" "dist-assets/${ASSET_NAME}.sha256"');
    // And read back afterwards: a release missing the artifact must FAIL,
    // because the hosting platform's upgrade automation builds on it.
    expect(release).toContain('gh release view "$TAG" --json assets');
    expect(release).toContain('Release incomplete');
    expect(release).toContain('gh release download "$TAG" --pattern');
    // The outer checksum is published where it can be read without the tarball.
    expect(release).toContain('ASSET_SHA256');
  });
});
