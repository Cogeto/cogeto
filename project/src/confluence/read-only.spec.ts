import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * READ-ONLY BY CONSTRUCTION (V2.5 item 8.2, issue A2): nothing in this
 * module can create, edit or delete anything in Confluence, and the property
 * is structural, not intentional. The client is the module's one HTTP
 * surface, both of its request helpers hard-code GET, and no mutating verb
 * is named anywhere in it. A violation fails the build here.
 */

const MODULE = path.resolve(__dirname);
const CLIENT = 'client.ts';

/** Anything that could open an HTTP request. */
const HTTP_SURFACE_TOKENS = [
  'fetch(',
  'fetchImpl(',
  'axios',
  'http.request',
  'https.request',
  'XMLHttpRequest',
  'undici',
];

function runtimeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe('confluence_read_only', () => {
  it('the_client_is_the_only_file_naming_an_http_surface', () => {
    const offenders = runtimeFiles(MODULE)
      .filter((file) => path.relative(MODULE, file) !== CLIENT)
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return HTTP_SURFACE_TOKENS.some((token) => text.includes(token));
      })
      .map((file) => path.relative(MODULE, file));
    expect(offenders).toEqual([]);
  });

  it('both_request_helpers_hard_code_get_and_nothing_else', () => {
    const client = readFileSync(path.join(MODULE, CLIENT), 'utf8');
    // Exactly two request options in the file (the json helper and the bytes
    // helper), and both name the constant method.
    expect(client.split('method:').length - 1).toBe(2);
    expect(client.split(`method: 'GET'`).length - 1).toBe(2);
  });

  it('no_mutating_verb_appears_in_the_client_in_any_form', () => {
    const client = readFileSync(path.join(MODULE, CLIENT), 'utf8');
    expect(client).not.toMatch(/['"`](POST|PUT|PATCH|DELETE)['"`]/);
    expect(client).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    expect(client).not.toMatch(/\.(post|put|patch|delete)\(/);
  });
});
