import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryModule } from './memory.module';
import type { MemoryModuleOptions } from './memory.module';
import { MemoryStore } from './memory.store';
import { MemorySystemStore } from './memory-system.store';
import type { IngestionCancellation, IngestionGuard } from './deletion-saga';

/**
 * The unscoped machine-read surface is unreachable from a request path
 * (V2.0 item 3.7).
 *
 * Nine methods on `MemoryStore` read across every owner with no Principal and
 * no scope gate: the nightly dreaming cycle's batch driver and the skill
 * runtime's step reads. `MemoryStore` is injected by every request-path module,
 * so the only thing keeping a controller from calling them was a section
 * comment reading "worker-only machine reads" — and one of them was in fact
 * being called on a request path. Two of the nine had no caller at all and are
 * gone; the request-path one became an owner-gated count; the rest moved to
 * {@link MemorySystemStore}, which is a provider ONLY where a composition root
 * registered the module with `systemReads: true`.
 *
 * What is asserted here is the structure, not the convention: the registration
 * the APP root performs cannot produce the class, the registration the WORKER
 * root performs can, the roots are wired that way in their own source, and no
 * request-path file names the class at all. A service in the app process that
 * asked for it would fail to resolve at boot — which the compose boot in the
 * definition of done exercises for real; Nest cannot be booted here because
 * vitest's transform emits no decorator metadata, so this proves the wiring
 * that produces that failure rather than staging it.
 *
 * Pure module metadata and file reads; nothing connects to anything.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The registration options every composition root passes, minus the flag. */
const BASE_OPTIONS: MemoryModuleOptions = {
  qdrantUrl: 'http://127.0.0.1:1',
  embeddingModel: 'test-embed',
  s3: { url: 'http://127.0.0.1:1', accessKey: 'x', secretKey: 'y', bucket: 'cogeto' },
  instanceKeyDir: '/tmp/cogeto-system-store-spec',
  // Never called: `register` is metadata, it instantiates nothing.
  ingestionGuard: class implements IngestionGuard {
    async cancelPending(): Promise<IngestionCancellation> {
      return 'already_ran';
    }
  },
};

/** Providers/exports of one registration, as plain identity checks. */
const registration = (systemReads?: boolean) => {
  const module = MemoryModule.register({
    ...BASE_OPTIONS,
    ...(systemReads ? { systemReads } : {}),
  });
  const provided = (module.providers ?? []).some(
    (provider) =>
      provider === MemorySystemStore ||
      (typeof provider === 'object' &&
        'provide' in provider &&
        provider.provide === MemorySystemStore),
  );
  const exported = (module.exports ?? []).includes(MemorySystemStore);
  return { provided, exported };
};

const read = (relative: string): string => readFileSync(path.join(SRC, relative), 'utf8');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
};

describe('the unscoped memory reads are worker-only by construction', () => {
  it('app_registration_cannot_produce_it: without systemReads the class is not a provider', () => {
    expect(registration()).toEqual({ provided: false, exported: false });
  });

  it('worker_registration_produces_it: with systemReads it is provided and exported', () => {
    expect(registration(true)).toEqual({ provided: true, exported: true });
  });

  it('roots_are_wired_that_way: the worker root asks for it and the app root does not', () => {
    expect(read('entrypoints/worker-root.module.ts')).toMatch(/systemReads:\s*true/);
    expect(read('entrypoints/app-root.module.ts')).not.toMatch(/systemReads/);
  });

  it('no_request_path_names_it: no controller or guard reaches for the unscoped surface', () => {
    const offenders = walk(SRC)
      .filter((file) => /\.(controller|guard)\.ts$/.test(file))
      .filter((file) => readFileSync(file, 'utf8').includes('MemorySystemStore'))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('gated_store_kept_no_ungated_read: MemoryStore exposes no unscoped scan', () => {
    const surface = Object.getOwnPropertyNames(MemoryStore.prototype);
    // The two dead ones (`listByKindsSystem`, `setAuthoredByUserBySourceSystem`)
    // are deleted outright; the rest moved.
    expect(surface.filter((name) => name.endsWith('System'))).toEqual([]);
    for (const gone of [
      'listTouchedBetween',
      'listLapsedActive',
      'listQuietCommitments',
      'retrieveEmbeddings',
    ]) {
      expect(surface).not.toContain(gone);
    }
    // And the replacement for the one request-path caller is a gated read.
    expect(surface).toContain('countBySourceForPrincipal');
  });

  it('system_surface_is_exactly_the_moved_set: no method grew back onto it', () => {
    expect(
      Object.getOwnPropertyNames(MemorySystemStore.prototype)
        .filter((name) => name !== 'constructor')
        .sort(),
    ).toEqual([
      'getManySystem',
      'listBySourceSystem',
      'listLapsedActive',
      'listQuietCommitments',
      'listTouchedBetween',
      'retrieveEmbeddings',
    ]);
  });
});
