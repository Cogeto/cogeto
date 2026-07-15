import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

/**
 * Trust scores (O7, decision 0032) — the machine-readable per-release quality
 * record the public website renders. This module is the single source of the
 * format: the Zod mirror of the PUBLISHED JSON Schema
 * (docs/trust-scores-schema/), the partial-emission helpers the eval
 * entrypoints call, and the publish logic the release pipeline runs.
 *
 * Schema stability is treated like the Passport format: additive changes bump
 * the minor, breaking changes bump the major, and every emitted file validates
 * before it is written.
 */

export const TRUST_SCORES_SCHEMA_VERSION = '1.0';

/** Default model tiers (mirrors .env.example / the gateway defaults). */
export const DEFAULT_MODELS = {
  pipeline: 'mistral-small-latest',
  answer: 'mistral-medium-latest',
  embedding: 'mistral-embed',
} as const;

const fraction = z.number().min(0).max(1);
const count = z.number().int().min(0);

export const languageMetricsSchema = z.object({
  language: z.string().min(2).max(8),
  golden_cases: count,
  extraction_precision: fraction,
  extraction_recall: fraction,
  verification_agreement: fraction,
  dedup_accuracy: fraction.nullable(),
  contradiction_recall: fraction.nullable(),
});

export const aggregateMetricsSchema = z.object({
  extraction_precision: fraction,
  extraction_recall: fraction,
  verification_agreement: fraction,
  dedup_accuracy: fraction,
  contradiction_recall: fraction,
});

export const chatSummarySchema = z.object({
  cases: count,
  passed: count,
  failed: z.array(z.string()),
});

export const configurationSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  models: z.object({
    pipeline: z.string().min(1),
    answer: z.string().min(1),
    embedding: z.string().min(1),
  }),
  redaction: z.boolean(),
  corpus: z.object({
    golden_cases: count,
    reconcile_pairs: count,
    chat_cases: count.optional(),
    per_language: z.array(z.object({ language: z.string().min(2).max(8), golden_cases: count })),
  }),
  metrics: z.object({
    per_language: z.array(languageMetricsSchema).min(1),
    aggregate: aggregateMetricsSchema,
    chat: chatSummarySchema.optional(),
  }),
});

export const generatedBySchema = z.object({
  release: z.string().regex(/^v\d+\.\d+\.\d+$/),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  harness: z.string().min(1),
  generated_at: z.string().datetime(),
  backfilled: z.boolean(),
});

export const trustScoresDocumentSchema = z.object({
  schema_version: z.literal(TRUST_SCORES_SCHEMA_VERSION),
  generated_by: generatedBySchema,
  configurations: z.array(configurationSchema).min(1),
  notes: z.array(z.string().min(1)).optional(),
});
export type TrustScoresDocument = z.infer<typeof trustScoresDocumentSchema>;
export type TrustConfiguration = z.infer<typeof configurationSchema>;

/**
 * A PARTIAL configuration snapshot — what one harness run knows. `npm run
 * eval -- --emit-json` writes the golden-set/reconciliation side; `npm run
 * eval:chat -- --emit-json` merges the chat summary into the same file. The
 * publisher requires the merged result to satisfy the full configuration
 * schema.
 */
export const partialFileSchema = z.object({
  schema_version: z.literal(TRUST_SCORES_SCHEMA_VERSION),
  harness: z.string().min(1),
  configuration: configurationSchema.deepPartial().extend({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    models: z.object({ pipeline: z.string(), answer: z.string(), embedding: z.string() }),
    redaction: z.boolean(),
  }),
});
export type PartialFile = z.infer<typeof partialFileSchema>;

export const indexEntrySchema = z.object({
  version: z.string().regex(/^v\d+\.\d+\.\d+$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  path: z.string().regex(/^v\d+\.\d+\.\d+\.json$/),
});
export const indexSchema = z.array(indexEntrySchema);

/** The configuration id: default tiers → mistral-default(-redacted); anything
 * else → mistral-custom(-redacted). Stable ids are the website's join key. */
export function deriveConfigurationId(models: {
  pipeline: string;
  answer: string;
  embedding: string;
}): string {
  const isDefault =
    models.pipeline === DEFAULT_MODELS.pipeline &&
    models.answer === DEFAULT_MODELS.answer &&
    models.embedding === DEFAULT_MODELS.embedding;
  const redacted =
    process.env.REDACTION_ENABLED === '1' || process.env.REDACTION_ENABLED === 'true';
  return `${isDefault ? 'mistral-default' : 'mistral-custom'}${redacted ? '-redacted' : ''}`;
}

/** Deep-merge one harness run's partial into an existing partial file (same
 * configuration id + models required — a mismatch is a hard error). */
export function mergePartial(existing: PartialFile | null, incoming: PartialFile): PartialFile {
  if (!existing) return incoming;
  if (existing.configuration.id !== incoming.configuration.id) {
    throw new Error(
      `partial merge refused: configuration id mismatch (${existing.configuration.id} vs ${incoming.configuration.id}) — emit different configurations to different files`,
    );
  }
  return {
    schema_version: TRUST_SCORES_SCHEMA_VERSION,
    harness: [existing.harness, incoming.harness].filter(Boolean).join(' + '),
    configuration: {
      ...existing.configuration,
      ...incoming.configuration,
      corpus: { ...existing.configuration.corpus, ...incoming.configuration.corpus },
      metrics: { ...existing.configuration.metrics, ...incoming.configuration.metrics },
    },
  };
}

/** Read-merge-validate-write a partial emission (the --emit-json flag). */
export function emitPartial(filePath: string, incoming: PartialFile): void {
  const existing = existsSync(filePath)
    ? partialFileSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')))
    : null;
  const merged = partialFileSchema.parse(mergePartial(existing, incoming));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

export interface PublishArgs {
  outDir: string;
  version: string; // vX.Y.Z
  commit: string;
  partialPaths: string[];
  notes?: string[];
  /** Injected for tests; the release pipeline passes the real time. */
  generatedAt?: string;
}

/**
 * The release-side publish: merge configuration partials into ONE immutable
 * release file + regenerate the index. Refuses to overwrite an existing
 * version file (release files are immutable — decision 0032); the index is
 * rebuilt from the directory so it can never list a missing file.
 */
export function publishTrustScores(args: PublishArgs): { file: string; index: string } {
  if (!/^v\d+\.\d+\.\d+$/.test(args.version)) {
    throw new Error(`version must be vX.Y.Z (got '${args.version}')`);
  }
  const outFile = path.join(args.outDir, `${args.version}.json`);
  if (existsSync(outFile)) {
    throw new Error(
      `refusing to overwrite ${outFile} — release trust-score files are immutable (decision 0032). ` +
        `If the numbers are wrong, publish a note in the NEXT release; never rewrite history.`,
    );
  }

  const partials = args.partialPaths.map((p) =>
    partialFileSchema.parse(JSON.parse(readFileSync(p, 'utf8'))),
  );
  if (partials.length === 0) throw new Error('at least one configuration partial is required');
  const ids = new Set(partials.map((p) => p.configuration.id));
  if (ids.size !== partials.length) {
    throw new Error(
      'duplicate configuration ids across partials — merge same-id runs into one file first',
    );
  }

  const document: TrustScoresDocument = trustScoresDocumentSchema.parse({
    schema_version: TRUST_SCORES_SCHEMA_VERSION,
    generated_by: {
      release: args.version,
      commit: args.commit,
      harness: partials.map((p) => p.harness).join(' | '),
      generated_at: args.generatedAt ?? new Date().toISOString(),
      backfilled: false,
    },
    configurations: partials.map((p) => configurationSchema.parse(p.configuration)),
    ...(args.notes && args.notes.length > 0 ? { notes: args.notes } : {}),
  });

  mkdirSync(args.outDir, { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  const index = rebuildIndex(args.outDir);
  return { file: outFile, index };
}

/** Rebuild index.json from the directory contents — newest first by semver. */
export function rebuildIndex(outDir: string): string {
  const files = readdirSync(outDir).filter((f) => /^v\d+\.\d+\.\d+\.json$/.test(f));
  const entries = files.map((file) => {
    const doc = trustScoresDocumentSchema.parse(
      JSON.parse(readFileSync(path.join(outDir, file), 'utf8')),
    );
    return {
      version: doc.generated_by.release,
      date: doc.generated_by.generated_at.slice(0, 10),
      path: file,
    };
  });
  entries.sort((a, b) => compareSemverDesc(a.version, b.version));
  for (const entry of entries) {
    if (entry.path !== `${entry.version}.json`) {
      throw new Error(`index integrity: ${entry.path} does not match its version ${entry.version}`);
    }
  }
  const validated = indexSchema.parse(entries);
  const indexFile = path.join(outDir, 'index.json');
  writeFileSync(indexFile, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  return indexFile;
}

export function compareSemverDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i]! !== pb[i]!) return pb[i]! - pa[i]!;
  }
  return 0;
}
