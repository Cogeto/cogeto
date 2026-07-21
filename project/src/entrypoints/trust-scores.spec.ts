import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveModelProviders } from '../model-gateway/index';
import {
  compareSemverDesc,
  configurationForEmission,
  emitPartial,
  indexSchema,
  mergePartial,
  partialFileSchema,
  publishTrustScores,
  rebuildIndex,
  TRUST_SCORES_SCHEMA_VERSION,
  trustScoresDocumentSchema,
} from './trust-scores';
import type { PartialFile } from './trust-scores';

/**
 * Trust scores (O7, decision 0032): the published per-release quality record.
 * Covers — schema validation of the example + every backfilled release file,
 * index integrity (every listed file exists, newest-first, nothing unlisted),
 * the immutability guard, and the partial-emission merge.
 */
const SRC = process.cwd();
const REPO = path.resolve(SRC, '../..');
const SCORES_DIR = path.join(REPO, 'eval', 'trust-scores');
const SCHEMA_DIR = path.join(REPO, 'docs', 'trust-scores-schema');

const tmpDirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trust-scores-spec-'));
  tmpDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const goldenPartial = (id = 'mistral-default'): PartialFile => ({
  schema_version: TRUST_SCORES_SCHEMA_VERSION,
  harness: 'extraction/v0002 + verification/v0004 · thresholds v1',
  configuration: {
    id,
    models: {
      pipeline: 'mistral-small-latest',
      answer: 'mistral-medium-latest',
      embedding: 'mistral-embed',
    },
    redaction: false,
    corpus: {
      golden_cases: 2,
      reconcile_pairs: 1,
      per_language: [{ language: 'en', golden_cases: 2 }],
    },
    metrics: {
      per_language: [
        {
          language: 'en',
          golden_cases: 2,
          extraction_precision: 0.9,
          extraction_recall: 0.8,
          verification_agreement: 0.85,
          dedup_accuracy: 1,
          contradiction_recall: 1,
        },
      ],
      aggregate: {
        extraction_precision: 0.9,
        extraction_recall: 0.8,
        verification_agreement: 0.85,
        dedup_accuracy: 1,
        contradiction_recall: 1,
      },
    },
  },
});

const chatPartial = (id = 'mistral-default'): PartialFile => ({
  schema_version: TRUST_SCORES_SCHEMA_VERSION,
  harness: 'chat answer/v0004 · grader eval-coverage/v0001',
  configuration: {
    id,
    models: {
      pipeline: 'mistral-small-latest',
      answer: 'mistral-medium-latest',
      embedding: 'mistral-embed',
    },
    redaction: false,
    corpus: { chat_cases: 3 },
    metrics: { chat: { cases: 3, passed: 2, failed: ['who_is_ana'] } },
  },
});

describe('trust scores — published files validate (decision 0032)', () => {
  it('the published example is schema-valid', () => {
    const example = JSON.parse(readFileSync(path.join(SCHEMA_DIR, 'example.json'), 'utf8'));
    expect(() => trustScoresDocumentSchema.parse(example)).not.toThrow();
  });

  it('every backfilled release file is schema-valid and marked backfilled', () => {
    const files = readdirSync(SCORES_DIR).filter((f) => /^v\d+\.\d+\.\d+\.json$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(2); // v0.8.0 + v0.9.1 backfill
    for (const file of files) {
      const doc = trustScoresDocumentSchema.parse(
        JSON.parse(readFileSync(path.join(SCORES_DIR, file), 'utf8')),
      );
      expect(doc.generated_by.release, file).toBe(file.replace(/\.json$/, ''));
      // Backfilled files must say so and explain themselves (the honesty line).
      if (doc.generated_by.backfilled) {
        expect(doc.notes?.length ?? 0, `${file} backfilled without notes`).toBeGreaterThan(0);
      }
    }
  });

  it('index integrity: every entry exists, matches its version, newest first, nothing unlisted', () => {
    const index = indexSchema.parse(
      JSON.parse(readFileSync(path.join(SCORES_DIR, 'index.json'), 'utf8')),
    );
    const files = readdirSync(SCORES_DIR).filter((f) => /^v\d+\.\d+\.\d+\.json$/.test(f));
    expect(index.map((e) => e.path).sort()).toEqual(files.sort());
    for (const entry of index) {
      expect(entry.path).toBe(`${entry.version}.json`);
    }
    const versions = index.map((e) => e.version);
    const sorted = [...versions].sort(compareSemverDesc);
    expect(versions).toEqual(sorted);
  });

  it('the published JSON Schema and the Zod mirror agree on the top-level contract', () => {
    const schema = JSON.parse(
      readFileSync(path.join(SCHEMA_DIR, 'trust-scores.schema.json'), 'utf8'),
    ) as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required.sort()).toEqual(['configurations', 'generated_by', 'schema_version']);
    expect(Object.keys(schema.properties).sort()).toEqual([
      'configurations',
      'generated_by',
      'notes',
      'schema_version',
    ]);
  });
});

describe('trust scores — emission and merge', () => {
  it('emitPartial merges the golden and chat runs into one configuration, either order', () => {
    const dir = tmp();
    const file = path.join(dir, 'partial.json');
    emitPartial(file, chatPartial());
    emitPartial(file, goldenPartial());
    const merged = partialFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    expect(merged.configuration.metrics?.chat?.passed).toBe(2);
    expect(merged.configuration.metrics?.aggregate?.extraction_precision).toBe(0.9);
    expect(merged.configuration.corpus?.chat_cases).toBe(3);
    expect(merged.configuration.corpus?.golden_cases).toBe(2);
    expect(merged.harness).toContain('extraction/v0002');
    expect(merged.harness).toContain('chat answer/v0004');
  });

  it('refuses to merge different configuration ids into one file', () => {
    expect(() =>
      mergePartial(goldenPartial('mistral-default'), chatPartial('mistral-custom')),
    ).toThrow(/configuration id mismatch/);
  });
});

/**
 * eval_emission_config_correct (decision 0040 ruling 5): both harnesses emit
 * the configuration through this one helper over the SAME resolver the gateway
 * boots with — the emitted id and models are the exact active configuration.
 */
describe('eval_emission_config_correct', () => {
  it('emits the default configuration exactly as resolved', () => {
    const providers = resolveModelProviders({ COGETO_MISTRAL_API_KEY: 'k' } as NodeJS.ProcessEnv, {
      redacted: false,
    });
    expect(configurationForEmission(providers)).toEqual({
      id: 'mistral-default',
      models: {
        pipeline: 'mistral-small-latest',
        answer: 'mistral-medium-latest',
        embedding: 'mistral-embed',
      },
    });
  });

  it('emits a mixed configuration with the exact per-tier models and derived id', () => {
    const providers = resolveModelProviders(
      {
        COGETO_PROVIDER_ANSWER: 'anthropic',
        COGETO_MODEL_ANSWER: 'claude-sonnet-4-6',
        COGETO_MODEL_PIPELINE: 'mistral-large-latest',
        COGETO_ANTHROPIC_API_KEY: 'ak',
        COGETO_MISTRAL_API_KEY: 'mk',
      } as NodeJS.ProcessEnv,
      { redacted: true },
    );
    const emission = configurationForEmission(providers);
    expect(emission.models).toEqual({
      pipeline: 'mistral-large-latest',
      answer: 'claude-sonnet-4-6',
      embedding: 'mistral-embed',
    });
    expect(emission.id).toBe(providers.id); // exact join key, redacted suffix included
    expect(emission.id.endsWith('-redacted')).toBe(true);
    // The emitted id stays inside the published schema's pattern.
    expect(emission.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe('trust scores — publish (immutability + index)', () => {
  const writePartial = (dir: string): string => {
    const file = path.join(dir, 'partial.json');
    emitPartial(file, goldenPartial());
    emitPartial(file, chatPartial());
    return file;
  };

  it('publishes a schema-valid release file and rebuilds a valid index', () => {
    const dir = tmp();
    const partial = writePartial(dir);
    const { file } = publishTrustScores({
      outDir: dir,
      version: 'v1.2.3',
      commit: 'a'.repeat(40),
      partialPaths: [partial],
      notes: ['first publish'],
      generatedAt: '2026-07-16T00:00:00.000Z',
    });
    const doc = trustScoresDocumentSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    expect(doc.generated_by.release).toBe('v1.2.3');
    expect(doc.generated_by.backfilled).toBe(false);
    expect(doc.configurations[0]!.metrics.chat?.failed).toEqual(['who_is_ana']);
    const index = indexSchema.parse(JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8')));
    expect(index).toEqual([{ version: 'v1.2.3', date: '2026-07-16', path: 'v1.2.3.json' }]);
  });

  it('REFUSES to overwrite an existing release file (immutable — decision 0032)', () => {
    const dir = tmp();
    const partial = writePartial(dir);
    const args = {
      outDir: dir,
      version: 'v1.2.3',
      commit: 'b'.repeat(40),
      partialPaths: [partial],
      generatedAt: '2026-07-16T00:00:00.000Z',
    };
    publishTrustScores(args);
    expect(() => publishTrustScores(args)).toThrow(/refusing to overwrite/);
  });

  it('a partial missing its aggregate metrics cannot publish (the merged configuration must be complete)', () => {
    const dir = tmp();
    const file = path.join(dir, 'chat-only.json');
    emitPartial(file, chatPartial());
    expect(() =>
      publishTrustScores({
        outDir: dir,
        version: 'v1.2.4',
        commit: 'c'.repeat(40),
        partialPaths: [file],
        generatedAt: '2026-07-16T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('orders multiple releases newest-first in the index', () => {
    const dir = tmp();
    const partial = writePartial(dir);
    for (const version of ['v0.9.0', 'v0.10.0', 'v0.9.1']) {
      publishTrustScores({
        outDir: dir,
        version,
        commit: 'd'.repeat(40),
        partialPaths: [partial],
        generatedAt: '2026-07-16T00:00:00.000Z',
      });
    }
    const index = indexSchema.parse(JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8')));
    expect(index.map((e) => e.version)).toEqual(['v0.10.0', 'v0.9.1', 'v0.9.0']);
  });

  it('rebuildIndex rejects a file whose content version disagrees with its name', () => {
    const dir = tmp();
    const partial = writePartial(dir);
    const { file } = publishTrustScores({
      outDir: dir,
      version: 'v2.0.0',
      commit: 'e'.repeat(40),
      partialPaths: [partial],
      generatedAt: '2026-07-16T00:00:00.000Z',
    });
    // Corrupt: rename the file so name and content disagree.
    writeFileSync(path.join(dir, 'v2.0.1.json'), readFileSync(file, 'utf8'));
    expect(() => rebuildIndex(dir)).toThrow(/does not match its version/);
  });
});
