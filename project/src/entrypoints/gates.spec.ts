import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Gate-config invariants (V2.0 item 3.4). The gate check itself runs live, so
 * without these a malformed `gates.json` or a language with no floors is only
 * discovered on `main`, after the merge. These run in the unit suite.
 *
 * The floors themselves are justified one by one in docs/eval/gate-model.md.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const GATES_FILE = path.join(ROOT, 'eval', 'gates.json');
const GOLDEN_DIR = path.join(ROOT, 'eval', 'golden');
const REWRITE_DIR = path.join(ROOT, 'eval', 'rewrite');

const METRICS = [
  'extraction_precision',
  'extraction_recall',
  'verification_agreement',
  'dedup_accuracy',
  'contradiction_precision',
  'contradiction_recall',
  'supersedes_accuracy',
  'rewrite_accuracy',
] as const;

const floors = z.object(
  Object.fromEntries(METRICS.map((m) => [m, z.number().min(0).max(1)])) as Record<
    (typeof METRICS)[number],
    z.ZodNumber
  >,
);
const gatesSchema = z.object({
  version: z.number(),
  note: z.string().min(1),
  gates: floors,
  per_language: z.record(z.string(), floors),
  chat_gates: z.object({ mean_coverage: z.number().min(0).max(1) }),
  chat_note: z.string().min(1),
});

const gates = gatesSchema.parse(JSON.parse(readFileSync(GATES_FILE, 'utf8')));
const languageDirs = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

describe('gates.json', () => {
  it('parses with every gated metric present at both layers', () => {
    expect(Object.keys(gates.gates).sort()).toEqual([...METRICS].sort());
  });

  it('gates every language the corpus contains: no language can hide in an aggregate', () => {
    // The whole point of the per-language layer. A new language directory with
    // no floors fails here rather than shipping ungated.
    for (const lang of languageDirs(GOLDEN_DIR)) {
      expect(gates.per_language, `golden language '${lang}' has no floors`).toHaveProperty(lang);
    }
    for (const lang of languageDirs(REWRITE_DIR)) {
      expect(gates.per_language, `rewrite language '${lang}' has no floors`).toHaveProperty(lang);
    }
  });

  it('points at the record that justifies the numbers', () => {
    expect(gates.note).toContain('gate-model.md');
  });
});
