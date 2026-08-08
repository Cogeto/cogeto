import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ResolvedModelProviders } from '../model-gateway/index';

/**
 * Trust scores (O7) — the machine-readable per-release quality
 * record the public website renders. This module is the single source of the
 * format: the Zod mirror of the PUBLISHED JSON Schema
 * (docs/trust-scores-schema/), the partial-emission helpers the eval
 * entrypoints call, and the publish logic the release pipeline runs.
 *
 * Schema stability is treated like the Passport format: additive changes bump
 * the minor, breaking changes bump the major, and every emitted file validates
 * before it is written.
 */

/**
 * The version EMITTED. 1.2 is additive over 1.1 (V2.3 item 6.4): `corpora`, an
 * optional per-corpus breakdown so a reader can see accuracy on DOCUMENTS
 * specifically rather than one undifferentiated figure. 1.1 was additive over
 * 1.0 (V2.0 item 3.4): contradiction precision, supersedes accuracy and
 * query-rewrite routing accuracy joined the published metrics.
 *
 * `metrics` and `corpus` keep meaning exactly what they meant in 1.1: the CORE
 * corpus (notes, emails, web pages, document excerpts) plus the query-rewrite
 * suite. The vertical corpus is never folded into them, so every historical
 * comparison stays valid and no trend line moves because a new corpus was
 * added.
 */
export const TRUST_SCORES_SCHEMA_VERSION = '1.2';

/**
 * The versions READABLE. Published release files are immutable, so every
 * historical 1.0 file must keep validating: `rebuildIndex` re-parses the whole
 * directory on every publish, and a reader that rejected 1.0 would break the
 * index the moment the emitted version moved.
 */
export const TRUST_SCORES_SCHEMA_VERSIONS = ['1.0', '1.1', '1.2'] as const;

/** Default model tiers (mirrors.env.example / the gateway defaults). */
const fraction = z.number().min(0).max(1);
const count = z.int().min(0);

export const languageMetricsSchema = z.object({
  language: z.string().min(2).max(8),
  golden_cases: count,
  reconcile_pairs: count.optional(),
  rewrite_cases: count.optional(),
  extraction_precision: fraction,
  extraction_recall: fraction,
  verification_agreement: fraction,
  dedup_accuracy: fraction.nullable(),
  contradiction_recall: fraction.nullable(),
  // ── Added in schema 1.1. Optional so the immutable 1.0 files still
  // validate; every file emitted from V2.0 item 3.4 on carries them.
  contradiction_precision: fraction.nullable().optional(),
  supersedes_accuracy: fraction.nullable().optional(),
  /** The supersedes denominator — a rate over one case means nothing. */
  supersedes_pairs: count.nullable().optional(),
  rewrite_accuracy: fraction.nullable().optional(),
});

export const aggregateMetricsSchema = z.object({
  extraction_precision: fraction,
  extraction_recall: fraction,
  verification_agreement: fraction,
  dedup_accuracy: fraction,
  contradiction_recall: fraction,
  // Added in schema 1.1, same back-compatibility rule as above.
  contradiction_precision: fraction.optional(),
  supersedes_accuracy: fraction.optional(),
  supersedes_pairs: count.optional(),
  rewrite_accuracy: fraction.optional(),
});

export const chatSummarySchema = z.object({
  cases: count,
  passed: count,
  failed: z.array(z.string()),
});

export const corpusSchema = z.object({
  golden_cases: count,
  reconcile_pairs: count,
  chat_cases: count.optional(),
  /** Added in schema 1.1 with the query-rewrite suite. */
  rewrite_cases: count.optional(),
  per_language: z.array(
    z.object({
      language: z.string().min(2).max(8),
      golden_cases: count,
      reconcile_pairs: count.optional(),
      rewrite_cases: count.optional(),
    }),
  ),
});

export const metricsSchema = z.object({
  per_language: z.array(languageMetricsSchema).min(1),
  aggregate: aggregateMetricsSchema,
  chat: chatSummarySchema.optional(),
});

/**
 * One measured corpus (schema 1.2, V2.3 item 6.4). The published record carries
 * BOTH corpora side by side, never averaged: `core` is the mature notes and
 * email set the project has measured since v0.8.0, `vertical` the real public
 * documents item 6.4 sourced. Their difficulty differs and their numbers differ,
 * and a reader who cannot tell them apart learns nothing from either.
 */
export const corpusResultSchema = z.object({
  /** Stable join key for the website: `core`, `vertical`. */
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** Human label for the corpus, e.g. "Documents (regulatory, standards, datasheets, tenders)". */
  label: z.string().min(1),
  /** One sentence on what the corpus is and why its difficulty differs. */
  description: z.string().min(1),
  extraction_cases: count,
  reconcile_pairs: count,
  per_language: z.array(languageMetricsSchema).min(1),
  aggregate: aggregateMetricsSchema,
});

export const configurationSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  models: z.object({
    pipeline: z.string().min(1),
    answer: z.string().min(1),
    embedding: z.string().min(1),
  }),
  redaction: z.boolean(),
  corpus: corpusSchema,
  metrics: metricsSchema,
  /**
   * Added in schema 1.2. Optional so every immutable 1.0 and 1.1 file still
   * validates; every file emitted from V2.3 item 6.4 on carries it, with one
   * entry per measured corpus.
   */
  corpora: z.array(corpusResultSchema).min(1).optional(),
});

/**
 * The version grammar: a release is `vX.Y.Z`; an
 * optional lowercase `-suffix` marks a NON-release measurement published
 * beside the releases (e.g. `v1.4.2-local`, a maintainer-run self-hosted
 * configuration). Suffixed versions are listed and validated like any other
 * file; release tags themselves stay plain semver, and the ordering treats a
 * suffixed version as OLDER than the plain release of the same number, the
 * semver pre-release rule.
 */
export const RELEASE_VERSION_RE = /^v\d+\.\d+\.\d+(?:-[a-z0-9][a-z0-9-]*)?$/;
export const RELEASE_FILE_RE = /^v\d+\.\d+\.\d+(?:-[a-z0-9][a-z0-9-]*)?\.json$/;

export const generatedBySchema = z.object({
  release: z.string().regex(RELEASE_VERSION_RE),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  harness: z.string().min(1),
  generated_at: z.iso.datetime(),
  backfilled: z.boolean(),
});

export const trustScoresDocumentSchema = z.object({
  schema_version: z.enum(TRUST_SCORES_SCHEMA_VERSIONS),
  generated_by: generatedBySchema,
  configurations: z.array(configurationSchema).min(1),
  notes: z.array(z.string().min(1)).optional(),
});
export type TrustScoresDocument = z.infer<typeof trustScoresDocumentSchema>;

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
  // Explicit partial shape (zod 4 removed.deepPartial): identity fields are
  // required; corpus/metrics are optional and one-level partial. A harness
  // side that emits a section must emit it complete — stricter at depth >= 2
  // than the old deepPartial, which loudly rejects half-written sections
  // instead of merging them silently.
  configuration: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    models: z.object({ pipeline: z.string(), answer: z.string(), embedding: z.string() }),
    redaction: z.boolean(),
    corpus: corpusSchema.partial().optional(),
    metrics: metricsSchema.partial().optional(),
    corpora: z.array(corpusResultSchema).min(1).optional(),
  }),
});
export type PartialFile = z.infer<typeof partialFileSchema>;

export const indexEntrySchema = z.object({
  version: z.string().regex(RELEASE_VERSION_RE),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  path: z.string().regex(RELEASE_FILE_RE),
});
export const indexSchema = z.array(indexEntrySchema);

/**
 * The configuration identity an eval run emits: both
 * harnesses resolve the SAME provider configuration the instance would boot
 * with, so `configuration.id` and the per-tier models are exact by
 * construction. Ids are the website's join key — the derivation (preset name
 * or the full per-tier form, `-redacted` suffix) lives with the resolver.
 */
export function configurationForEmission(
  providers: ResolvedModelProviders,
  options: {
    /**
     * PROBED reasoning state (reasoning support Part C, honesty rule 3): a run
     * with thinking on is a different measurement, so the marker joins the id
     * the way `--vis-` does. Appended HERE, at emission time, rather than in
     * the resolver: whether a binding reasons is a runtime fact the static
     * resolver cannot know, and only emission labels a measurement. A
     * Mistral-routed run probes false and emits the unchanged id, so every
     * existing artifact, gate and cached fixture is untouched.
     */
    reasoning?: boolean;
  } = {},
): {
  id: string;
  models: { pipeline: string; answer: string; embedding: string };
} {
  return {
    id: options.reasoning ? `${providers.id}--reasoning` : providers.id,
    models: {
      pipeline: providers.tiers.pipeline.model,
      answer: providers.tiers.answer.model,
      embedding: providers.tiers.embedding.model,
    },
  };
}

/** Deep-merge one harness run's partial into an existing partial file (same
 * configuration id + models required — a mismatch is a hard error). */
export function mergePartial(existing: PartialFile | null, incoming: PartialFile): PartialFile {
  if (!existing) return incoming;
  if (existing.configuration.id !== incoming.configuration.id) {
    throw new Error(
      `partial merge refused: configuration id mismatch (${existing.configuration.id} vs ${incoming.configuration.id}), emit different configurations to different files`,
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
      // Whole-array replace, not a merge: only the golden-set harness emits
      // corpora and it emits all of them at once, so a partial merge would be
      // a way to publish half a corpus list.
      ...((incoming.configuration.corpora ?? existing.configuration.corpora)
        ? { corpora: incoming.configuration.corpora ?? existing.configuration.corpora }
        : {}),
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
 * version file (release files are immutable); the index is
 * rebuilt from the directory so it can never list a missing file.
 */
export function publishTrustScores(args: PublishArgs): { file: string; index: string } {
  if (!RELEASE_VERSION_RE.test(args.version)) {
    throw new Error(`version must be vX.Y.Z or vX.Y.Z-suffix (got '${args.version}')`);
  }
  const outFile = path.join(args.outDir, `${args.version}.json`);
  if (existsSync(outFile)) {
    throw new Error(
      `refusing to overwrite ${outFile}, release trust-score files are immutable. ` +
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
      'duplicate configuration ids across partials, merge same-id runs into one file first',
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
  const files = readdirSync(outDir).filter((f) => RELEASE_FILE_RE.test(f));
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
  const parse = (v: string): { nums: [number, number, number]; suffix: string } => {
    const m = /^v(\d+)\.(\d+)\.(\d+)(?:-([a-z0-9-]+))?$/.exec(v);
    if (!m) return { nums: [0, 0, 0], suffix: v };
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], suffix: m[4] ?? '' };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pb.nums[i]! - pa.nums[i]!;
  }
  if (pa.suffix === pb.suffix) return 0;
  // The semver pre-release rule: a suffixed version is OLDER than the plain
  // release of the same number; among suffixes, alphabetical for determinism.
  if (pa.suffix === '') return -1;
  if (pb.suffix === '') return 1;
  return pa.suffix < pb.suffix ? -1 : 1;
}
