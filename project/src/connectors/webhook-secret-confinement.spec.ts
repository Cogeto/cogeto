import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The webhook signing secret never comes back out (V2.5 item 8.1, issue D),
 * the key-confinement shape applied to the third sealed column.
 *
 * This is the ONE secret the app process must open (the hostile-facing
 * ingress verifies signatures over raw bytes), which is exactly why it is
 * not an identity credential: the credential opener is worker-only. The
 * containment compensates: the sealed column is named in one file, opened in
 * one function, and the plaintext is returned exactly once, at rotation.
 */

const SRC = path.resolve(__dirname, '..');
const MODULE = path.resolve(__dirname);
const STORE_FILE = 'persistence/connector-store.ts';

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

describe('webhook_secret_confinement', () => {
  it('the_sealed_column_is_named_in_exactly_one_file', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.endsWith('.spec.ts'))
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return text.includes('connector.webhookSecret') || text.includes('webhook_secret');
      })
      .map((file) => path.relative(SRC, file))
      // The Drizzle declaration and the migration comment name the column;
      // both are declarations, not reads.
      .filter(
        (file) =>
          file !== `connectors/persistence/tables.ts` &&
          !file.startsWith('migrations/') &&
          file !== `connectors/${STORE_FILE}`,
      );
    expect(offenders).toEqual([]);
  });

  it('opened_in_exactly_one_function_and_returned_once_at_rotation', () => {
    const store = readFileSync(path.join(MODULE, STORE_FILE), 'utf8');
    expect(store.split('openSecret(').length - 1).toBe(1);
    expect(store).toContain('openWebhookSecret');
    // Rotation seals a fresh random secret and returns it; nothing reads the
    // stored value back out for display.
    expect(store).toContain('rotateWebhookSecret');
  });

  it('the_controller_returns_the_secret_only_from_rotation', () => {
    const controller = readFileSync(path.join(MODULE, 'connectors.controller.ts'), 'utf8');
    expect(controller).not.toContain('openWebhookSecret');
  });
});
