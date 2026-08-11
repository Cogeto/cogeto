import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A stored connector credential never comes back out (V2.5 item 8.1,
 * issue B), the `key-confinement.spec.ts` shape applied to identity's
 * sealed column.
 *
 * Three claims, checked against the source itself rather than kept true by
 * a reviewer remembering them:
 *
 * 1. The sealed column is named in exactly one file, and decrypted
 *    (`openSecret(`) in exactly one function there, the opener.
 * 2. The opener is provided only when a composition root passes
 *    `credentialReads: true`: the worker root does, the app root does not,
 *    so the process serving requests cannot resolve a decrypting read.
 * 3. No HTTP surface anywhere names the opener: controllers can store,
 *    describe and destroy, never open.
 */

const SRC = path.resolve(__dirname, '..');
const MODULE = path.resolve(__dirname);
const STORE_FILE = 'persistence/connector-credential-store.ts';

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe('credential_confinement: a stored credential cannot leave the seam', () => {
  it('the_sealed_column_is_named_in_exactly_one_file', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.endsWith('.spec.ts'))
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return text.includes('connectorCredential.secret');
      })
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([`identity/${STORE_FILE}`]);

    const store = readFileSync(path.join(MODULE, STORE_FILE), 'utf8');
    // Exactly one SELECT names the sealed column, inside the opener.
    const selects = store.split('secret: connectorCredential.secret').length - 1;
    expect(selects).toBe(1);
    // And exactly one call decrypts, also there.
    const opens = store.split('openSecret(').length - 1;
    expect(opens).toBe(1);
    expect(store).toContain('class ConnectorCredentialOpener');
  });

  it('the_summary_projection_omits_the_sealed_column', () => {
    const store = readFileSync(path.join(MODULE, STORE_FILE), 'utf8');
    const projection = store.slice(
      store.indexOf('const SUMMARY_COLUMNS'),
      store.indexOf('} as const;'),
    );
    expect(projection).not.toContain('secret');
  });

  it('the_opener_is_worker_only: the app root never passes credentialReads', () => {
    const roots = path.resolve(SRC, 'entrypoints');
    const appRoot = readFileSync(path.join(roots, 'app-root.module.ts'), 'utf8');
    const workerRoot = readFileSync(path.join(roots, 'worker-root.module.ts'), 'utf8');
    // Comments may NAME the flag; only the worker may PASS it.
    expect(appRoot).not.toContain('credentialReads: true');
    expect(workerRoot).toContain('credentialReads: true');
    // The module gates BOTH the provider and the export on the flag, so a
    // root without it cannot resolve the opener at all.
    const module = readFileSync(path.join(MODULE, 'identity.module.ts'), 'utf8');
    const gated = module.split('options.credentialReads ? [ConnectorCredentialOpener]').length - 1;
    expect(gated).toBe(2);
  });

  it('no_controller_names_the_opener', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => file.endsWith('.controller.ts'))
      .filter((file) => readFileSync(file, 'utf8').includes('ConnectorCredentialOpener'))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('nothing_logs_or_audits_credential_material', () => {
    const store = readFileSync(path.join(MODULE, STORE_FILE), 'utf8');
    // The audit details are structural: booleans and counts, never a token.
    expect(store).toContain('hasRefreshToken: !!input.material.refreshToken');
    expect(store).not.toMatch(/\$\{[^}]*accessToken[^}]*\}/);
    expect(store).not.toMatch(/\$\{[^}]*refreshToken[^}]*\}/);
  });
});
