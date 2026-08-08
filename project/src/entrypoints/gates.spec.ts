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
/** The vertical corpus (V2.3 item 6.4): its own floors, its own sets. */
const VERTICAL_DIR = path.join(ROOT, 'eval', 'vertical', 'cases');

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
/**
 * The vertical corpus's floors carry every metric EXCEPT `rewrite_accuracy`:
 * the query-rewrite suite is a corpus of chat turns, not of documents, and
 * gating a metric this corpus cannot measure would gate the harness's
 * empty-arm convention rather than the system.
 */
const VERTICAL_METRICS = METRICS.filter((m) => m !== 'rewrite_accuracy');
const verticalFloors = z.object(
  Object.fromEntries(VERTICAL_METRICS.map((m) => [m, z.number().min(0).max(1)])) as Record<
    (typeof VERTICAL_METRICS)[number],
    z.ZodNumber
  >,
);
const gatesSchema = z.object({
  version: z.number(),
  note: z.string().min(1),
  gates: floors,
  per_language: z.record(z.string(), floors),
  vertical: z.object({
    note: z.string().min(1),
    gates: verticalFloors,
    per_language: z.record(z.string(), verticalFloors),
  }),
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

  it('gates every set the vertical corpus contains, including the cross-language one', () => {
    // Same hole, closed the same way: a set the harness measures and this file
    // does not name would ship ungated. `xl` is a set like a language here.
    for (const set of languageDirs(VERTICAL_DIR)) {
      expect(gates.vertical.per_language, `vertical set '${set}' has no floors`).toHaveProperty(
        set,
      );
    }
  });

  it('does not gate the vertical corpus on a metric it cannot measure', () => {
    expect(Object.keys(gates.vertical.gates).sort()).toEqual([...VERTICAL_METRICS].sort());
    expect(Object.keys(gates.vertical.gates)).not.toContain('rewrite_accuracy');
  });

  it("keeps the two corpora separate: neither block borrows the other's floors", () => {
    // The governing rule from V2.0 item 3.4 forbids averaging a hard new corpus
    // into a mature one, and copying floors across would be the same mistake in
    // a different place. The vertical corpus is HARDER, so no vertical floor may
    // sit at or above its core counterpart without a measurement saying so.
    for (const metric of VERTICAL_METRICS) {
      expect(
        gates.vertical.gates[metric],
        `vertical ${metric} floor equals the core floor exactly, which suggests it was copied rather than measured`,
      ).not.toBe(gates.gates[metric]);
    }
  });

  it('points at the record that justifies the numbers', () => {
    expect(gates.note).toContain('gate-model.md');
    expect(gates.vertical.note).toContain('gate-model.md');
  });
});
