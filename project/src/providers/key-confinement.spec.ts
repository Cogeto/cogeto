import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A saved provider key never comes back out (V2.4 item 7.1).
 *
 * The plan states this as a rule with no exceptions: a key is "never returned
 * to the client, never appears in a response, a log line, an error, an export,
 * or a health field". That is not a property a reviewer can keep true by
 * remembering it, so it is enforced structurally, the way
 * `no_provider_leakage` enforces the seam.
 *
 * Two claims, both checked against the source itself:
 *
 * 1. The sealed column is SELECTED in exactly one function. Everything else
 *    reads a projection that does not contain it, so no DTO can carry key
 *    material even by accident.
 * 2. The sealed column and the decrypting function are named only inside this
 *    module. A key that no other module can name is a key no other module can
 *    serialize.
 */

const SRC = path.resolve(__dirname, '..');
const MODULE = path.resolve(__dirname);

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

describe('provider_key_confinement: a stored key cannot leave the module', () => {
  it('the_sealed_column_is_selected_in_exactly_one_place', () => {
    const selectors = sourceFiles(MODULE)
      .filter((file) => !file.endsWith('.spec.ts'))
      // The Drizzle column object is `modelProvider.apiKeySecret`; only the
      // store may name it, and only in the one function the resolver calls.
      .filter((file) => readFileSync(file, 'utf8').includes('modelProvider.apiKeySecret'))
      .map((file) => path.relative(MODULE, file));
    expect(selectors.sort()).toEqual(['persistence/provider-store.ts']);

    const store = readFileSync(path.join(MODULE, 'persistence/provider-store.ts'), 'utf8');
    // Exactly one SELECT names it, and it is the one the resolver calls.
    const selects = store.split('apiKeySecret: modelProvider.apiKeySecret').length - 1;
    expect(selects).toBe(1);
    expect(store).toContain('listProvidersWithSecrets');
  });

  it('nothing_outside_the_module_names_the_column', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.startsWith(MODULE))
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return text.includes('api_key_secret') || text.includes('apiKeySecret');
      })
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('every_secret_opener_is_a_known_confined_site', () => {
    // The sealed-secret mechanism moved to infrastructure (V2.5 item 8.1) so
    // provider keys and connector credentials share ONE implementation. The
    // decrypting function may therefore be CALLED outside this module, but
    // only at the enumerated sites, each of which is itself confined by its
    // own structural spec. A new caller of openSecret() is a new place secret
    // material exists in memory, and it must be added here deliberately,
    // with its own confinement spec, or this test fails the build.
    const allowed = [
      // The mechanism itself and its unit spec.
      'infrastructure/secret-box.ts',
      'infrastructure/secret-box.spec.ts',
      // Identity's connector-credential opener (credential-confinement.spec.ts).
      'identity/persistence/connector-credential-store.ts',
      'identity/credential-confinement.spec.ts',
      // The connectors platform's webhook signing secret, the one secret the
      // app-side ingress must open (webhook-secret-confinement.spec.ts).
      'connectors/persistence/connector-store.ts',
      'connectors/webhook-secret-confinement.spec.ts',
    ];
    const callers = sourceFiles(SRC)
      .filter((file) => !file.startsWith(MODULE))
      .filter((file) => readFileSync(file, 'utf8').includes('openSecret('))
      .map((file) => path.relative(SRC, file))
      .filter((file) => !allowed.includes(file));
    expect(callers).toEqual([]);
  });

  it('no_response_type_carries_a_key: only the write-only request shapes mention one', () => {
    const dto = readFileSync(path.resolve(SRC, '..', 'shared', 'src', 'providers.ts'), 'utf8');
    // `apiKey` appears only inside the two REQUEST interfaces, which travel
    // client → server. Every response type carries `hasApiKey` and nothing more.
    const requestBlock = dto.slice(dto.indexOf('export interface CreateProviderRequest'));
    const responseBlock = dto.slice(0, dto.indexOf('export interface CreateProviderRequest'));
    expect(responseBlock).not.toMatch(/\bapiKey\b/);
    expect(responseBlock).toContain('hasApiKey');
    expect(requestBlock).toMatch(/\bapiKey\b/);
  });

  it('the_service_never_logs_or_audits_a_key, only whether one is present', () => {
    const service = readFileSync(path.join(MODULE, 'provider-config.service.ts'), 'utf8');
    // The audit detail is structural (AGENTS.md): a boolean and a type.
    expect(service).toContain('hasApiKey: !!request.apiKey');
    // Nothing interpolates a key into a message, a log line or a detail field.
    expect(service).not.toMatch(/\$\{[^}]*apiKey[^}]*\}/);
  });
});
