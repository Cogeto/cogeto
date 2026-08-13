import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import {
  evalConfigSchema,
  RECONCILE_CONTRADICTION_PROMPT,
  RECONCILE_DEDUP_PROMPT,
  runGoldenEval,
  runReconcileEval,
} from '../ingestion/index';
import type {
  EvalMetrics,
  EvalRunResult,
  ReconcileEvalMetrics,
  ReconcileEvalResult,
} from '../ingestion/index';
import { runRewriteEval } from '../retrieval/index';
import type { RewriteEvalMetrics } from '../retrieval/index';
import { createModelGateway, probeReasoning } from '../model-gateway/index';
import { resolveEvalProviders, requireConfiguredProviders } from './eval-env';
import { EVAL_SCORING_VERSION, evalCacheModeFromEnv, wrapWithEvalCache } from './eval-cache';
import { configurationForEmission, emitPartial } from './trust-scores';
import { TRUST_SCORES_SCHEMA_VERSION } from './trust-scores';

/**
 * npm run eval — the golden-set harness (spec §14; docs/eval-golden-set.md) against
 * the live gateway. Prints per-language + aggregate metrics prominently and
 * appends them, with prompt versions, to docs/eval/history.md. No CI gates yet
 * (Session 4 turns them on).
 *
 * Needs only an API key: COGETO_MISTRAL_API_KEY in the env, or in the repo-root .env.
 */

// dist layout: project/src/dist/entrypoints → repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const GOLDEN_DIR = path.join(REPO_ROOT, 'project', 'eval', 'golden');
/**
 * The vertical corpus (V2.3 item 6.4): the same harness, the same scoring, a
 * DIFFERENT corpus, reported and gated SEPARATELY. Averaging a hard new corpus
 * into a mature one hides both signals, so nothing here is folded into the
 * numbers above: the aggregate would look worse without explaining why, and the
 * vertical result would become unreadable.
 *
 * Cases live under `cases/` rather than at the root so the corpus directory can
 * also hold `documents.json`, `fetch.mjs`, `LABELLING.md`, the gitignored
 * `originals/` and the PENDING `authority/` cases without any of them being
 * mistaken for a language by the loaders, which treat every directory under the
 * corpus root as one.
 */
const VERTICAL_DIR = path.join(REPO_ROOT, 'project', 'eval', 'vertical', 'cases');
const REWRITE_DIR = path.join(REPO_ROOT, 'project', 'eval', 'rewrite');
const CACHE_DIR = path.join(REPO_ROOT, 'project', 'eval', 'cache');
const CONFIG_FILE = path.join(REPO_ROOT, 'project', 'eval', 'eval-config.json');
const GATES_FILE = path.join(REPO_ROOT, 'project', 'eval', 'gates.json');
const HISTORY_FILE = path.join(REPO_ROOT, 'docs', 'eval', 'history.md');

/**
 * The spec §14 CI gates. Two layers, both ratchet-up-only (V2.0 item 3.4):
 * `gates` are the aggregate floors, `per_language` the floors for each
 * language the harness reports, so a weak language can no longer hide inside a
 * healthy average. A language the harness measures but `per_language` does not
 * name is a GATE FAILURE, not a pass: an ungated language is exactly the hole
 * the per-language floors close.
 */
const metricFloorsSchema = z.object({
  extraction_precision: z.number(),
  extraction_recall: z.number(),
  verification_agreement: z.number(),
  dedup_accuracy: z.number(),
  contradiction_precision: z.number(),
  contradiction_recall: z.number(),
  supersedes_accuracy: z.number(),
  rewrite_accuracy: z.number(),
});
/**
 * The vertical corpus's floors (V2.3 item 6.4). Same metrics minus
 * `rewrite_accuracy`: the query-rewrite suite is a corpus of chat turns, not of
 * documents, and there is no vertical arm of it. Gating a metric this corpus
 * cannot measure would mean gating the harness's empty-arm convention, which
 * scores 1 whatever the system does.
 */
const verticalFloorsSchema = z.object({
  extraction_precision: z.number(),
  extraction_recall: z.number(),
  verification_agreement: z.number(),
  dedup_accuracy: z.number(),
  contradiction_precision: z.number(),
  contradiction_recall: z.number(),
  supersedes_accuracy: z.number(),
});
const gatesSchema = z.object({
  version: z.number(),
  gates: metricFloorsSchema,
  per_language: z.record(z.string(), metricFloorsSchema),
  vertical: z.object({
    gates: verticalFloorsSchema,
    per_language: z.record(z.string(), verticalFloorsSchema),
  }),
});
type MetricFloors = z.infer<typeof metricFloorsSchema>;
type VerticalFloors = z.infer<typeof verticalFloorsSchema>;

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function metricsRow(m: EvalMetrics): string {
  return (
    `| ${m.label} | ${m.cases} | ${pct(m.precision)} (${m.matchedExtracted}/${m.extractedFacts}) ` +
    `| ${pct(m.recall)} (${m.matchedMustExtract}/${m.mustExtractLabels}) ` +
    `| ${pct(m.verificationAgreement)} (${m.verificationAgreed}/${m.verificationCases}) |`
  );
}

function reconcileRow(m: ReconcileEvalMetrics): string {
  return (
    `| ${m.label} | ${m.dedupPairs} | ${pct(m.dedupAccuracy)} (${m.dedupEarned}/${m.dedupWeight}` +
    `${m.falseMerges ? `, ${m.falseMerges} FALSE MERGE${m.falseMerges > 1 ? 'S' : ''}` : ''}) ` +
    `| ${m.contradictionPairs} | ${pct(m.contradictionPrecision)} (${m.correctContradictions}/${m.flaggedContradictions}) ` +
    `| ${pct(m.contradictionRecall)} (${m.correctContradictions}/${m.expectedContradictions}) ` +
    `| ${pct(m.supersedesAccuracy)} (${m.supersedesCorrect}/${m.supersedesPairs + m.supersedesFalsePositives}` +
    `${m.supersedesFalsePositives ? `, ${m.supersedesFalsePositives} FALSE` : ''}) ` +
    `| ${m.candidateMisses} |`
  );
}

function rewriteRow(m: RewriteEvalMetrics): string {
  return `| ${m.label} | ${m.cases} | ${pct(m.accuracy)} (${m.passed}/${m.cases}) |`;
}

async function main(): Promise<void> {
  const { providers, redaction } = await resolveEvalProviders(REPO_ROOT);
  const cacheMode = evalCacheModeFromEnv();
  // A replay needs no provider at all — that is the point on a fork pull
  // request, where no secret exists.
  if (cacheMode !== 'replay') requireConfiguredProviders(providers, 'eval');
  const config = evalConfigSchema.parse(JSON.parse(await readFile(CONFIG_FILE, 'utf8')));
  const {
    gateway,
    store: cacheStore,
    manifest: cacheManifest,
  } = wrapWithEvalCache(
    createModelGateway({
      providers,
      redaction,
      // Deterministic sampling for comparable runs.
      temperature: 0,
    }),
    { mode: cacheMode, dir: CACHE_DIR, providers },
  );
  if (cacheMode === 'replay') {
    console.log(
      `CACHED REPLAY (${cacheManifest?.configuration_id}, recorded ${cacheManifest?.recorded_at.slice(0, 10)}): ` +
        `this run catches prompt, pipeline and scoring regressions. It does NOT catch model-side drift, ` +
        `and it is never published as a trust score.`,
    );
  } else if (cacheMode === 'record') {
    console.log(`RECORDING eval cache → ${path.relative(REPO_ROOT, CACHE_DIR)}`);
  }
  console.log(
    `configuration: ${providers.id} (pipeline ${providers.tiers.pipeline.provider}/${providers.tiers.pipeline.model} · ` +
      `answer ${providers.tiers.answer.provider}/${providers.tiers.answer.model} · ` +
      `embeddings ${providers.tiers.embedding.provider}/${providers.tiers.embedding.model})`,
  );
  if (redaction) console.log(`redaction: ON (sidecar ${redaction.url}), measuring the delta`);

  console.log(`golden set: ${GOLDEN_DIR}`);
  console.log(
    `thresholds v${config.version}: similarity ≥ ${config.similarity_threshold}, entity overlap ≥ ${config.entity_overlap_threshold}`,
  );
  const result = await runGoldenEval({
    gateway,
    goldenDir: GOLDEN_DIR,
    config,
    log: (message) => console.log(`  ${message}`),
  });

  const table = [
    '| set | cases | extraction precision | extraction recall | verification agreement |',
    '|---|---|---|---|---|',
    ...result.perLanguage.map(metricsRow),
    metricsRow(result.aggregate),
  ].join('\n');

  console.log('\n================ GOLDEN SET RESULTS ================');
  console.log(
    `prompts: ${result.promptVersions} · thresholds v${result.config.version} · ${result.caseCount} cases`,
  );
  console.log(table);
  console.log('====================================================\n');

  // Reconciliation pair cases — the same run,
  // so the trust score always reports extraction and reconciliation together.
  console.log('reconciliation pairs:');
  const reconcile = await runReconcileEval({
    gateway,
    goldenDir: GOLDEN_DIR,
    log: (message) => console.log(`  ${message}`),
  });
  const reconcileTable = [
    '| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |',
    '|---|---|---|---|---|---|---|---|',
    ...reconcile.perLanguage.map(reconcileRow),
    reconcileRow(reconcile.aggregate),
  ].join('\n');

  console.log('\n============= RECONCILIATION PAIR RESULTS =============');
  console.log(
    `prompts: reconcile_dedup/v0001 + reconcile_contradiction/v0001 · reconcile-config v${reconcile.configVersion} · ${reconcile.pairCount} pairs`,
  );
  console.log(reconcileTable);
  console.log('=======================================================\n');

  // Query-rewrite cases (V2.0 item 3.4): the routing decision itself, measured
  // directly instead of inferred from a downstream answer.
  console.log('query-rewrite cases:');
  const rewrite = await runRewriteEval({
    gateway,
    casesDir: REWRITE_DIR,
    log: (message) => console.log(`  ${message}`),
  });
  const rewriteTable = [
    '| set | cases | routing accuracy |',
    '|---|---|---|',
    ...rewrite.perLanguage.map(rewriteRow),
    rewriteRow(rewrite.aggregate),
  ].join('\n');

  console.log('\n=============== QUERY-REWRITE RESULTS ================');
  console.log(`prompt: ${rewrite.promptVersion} · ${rewrite.caseCount} cases`);
  console.log(rewriteTable);
  for (const failure of rewrite.failures) {
    console.log(`  ${failure.caseId}: ${failure.reasons.join('; ')}`);
  }
  console.log('=====================================================\n');

  // ── The vertical corpus (V2.3 item 6.4) ────────────────────────
  // Real public documents: regulatory guidance, standards, device datasheets,
  // public tender specifications, one scanned publication. Same harness, same
  // scoring, same thresholds; a separate corpus, reported on its own. What it
  // is, where every document came from, and how it was labelled:
  // project/eval/vertical/README.md and LABELLING.md.
  console.log('vertical corpus (documents):');
  const vertical = await runGoldenEval({
    gateway,
    goldenDir: VERTICAL_DIR,
    config,
    log: (message) => console.log(`  ${message}`),
  });
  const verticalReconcile = await runReconcileEval({
    gateway,
    goldenDir: VERTICAL_DIR,
    log: (message) => console.log(`  ${message}`),
  });
  const verticalTable = [
    '| set | cases | extraction precision | extraction recall | verification agreement |',
    '|---|---|---|---|---|',
    ...vertical.perLanguage.map(metricsRow),
    metricsRow(vertical.aggregate),
  ].join('\n');
  const verticalReconcileTable = [
    '| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |',
    '|---|---|---|---|---|---|---|---|',
    ...verticalReconcile.perLanguage.map(reconcileRow),
    reconcileRow(verticalReconcile.aggregate),
  ].join('\n');
  console.log('\n============== VERTICAL CORPUS RESULTS ==============');
  console.log(
    `${vertical.caseCount} extraction cases + ${verticalReconcile.pairCount} pairs over real public documents. ` +
      `NOT averaged into the numbers above: a harder corpus folded into a mature one hides both signals.`,
  );
  console.log(verticalTable);
  console.log(verticalReconcileTable);
  console.log('=====================================================\n');

  // The history file is the record of MEASURED runs. A cached replay measures
  // the harness, not the models, so it never writes there (V2.0 item 3.4).
  if (cacheMode === 'replay') {
    console.log('cached replay: docs/eval/history.md not touched (it records live measurements)');
  } else {
    await mkdir(path.dirname(HISTORY_FILE), { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    await appendFile(
      HISTORY_FILE,
      `\n## ${stamp}, ${result.promptVersions} (thresholds v${result.config.version}, ${result.caseCount} cases)\n\n${table}\n` +
        `\n## ${stamp}, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v${reconcile.configVersion}, ${reconcile.pairCount} pairs)\n\n${reconcileTable}\n` +
        `\n## ${stamp}, ${rewrite.promptVersion} (query-rewrite routing, ${rewrite.caseCount} cases)\n\n${rewriteTable}\n` +
        `\n## ${stamp}, VERTICAL corpus (real documents, ${vertical.caseCount} cases + ${verticalReconcile.pairCount} pairs)\n\n${verticalTable}\n\n${verticalReconcileTable}\n`,
      'utf8',
    );
    console.log(`appended to ${path.relative(REPO_ROOT, HISTORY_FILE)}`);
  }

  // ── Trust-score emission (O7): --emit-json <path> ─────────
  // Writes/merges the machine-readable partial the release publisher combines
  // into eval/trust-scores/vX.Y.Z.json. Emitted BEFORE the gate check so the
  // numbers are honest even on a breach (the release only publishes after
  // gates pass anyway).
  const emitIdx = process.argv.indexOf('--emit-json');
  const emitPath = emitIdx >= 0 ? process.argv[emitIdx + 1] : undefined;
  if (emitIdx >= 0 && !emitPath) {
    console.error('--emit-json requires a file path');
    process.exit(2);
  }
  if (emitPath) {
    // A cached replay must NEVER become a published trust score: the numbers
    // would describe recorded responses, not the models a customer runs
    // against (V2.0 item 3.4). Refused loudly rather than silently skipped.
    if (cacheMode === 'replay') {
      console.error(
        'refusing --emit-json under COGETO_EVAL_CACHE=replay: trust scores are published ' +
          'from LIVE runs only. Re-run without the cache to emit.',
      );
      process.exit(2);
    }
    // The ACTIVE configuration, from the same resolver the gateway was built
    // with — id and models are exact by construction. Reasoning is PROBED so
    // the emitted id labels what this run actually measured (Part C); replay
    // never reaches this branch, so the probe only runs on live emissions.
    const reasoningProbe = await probeReasoning(gateway, providers);
    const { id, models } = configurationForEmission(providers, {
      reasoning: reasoningProbe.reasoning,
    });
    const reconcileByLabel = new Map(reconcile.perLanguage.map((m) => [m.label, m]));
    const rewriteByLabel = new Map(rewrite.perLanguage.map((m) => [m.label, m]));

    /**
     * One corpus's published block (schema 1.2, V2.3 item 6.4). Built for BOTH
     * corpora from the same function so neither can drift into a different
     * shape, and so nothing has to be averaged to publish them together.
     */
    const corpusBlock = (
      id: string,
      label: string,
      description: string,
      extraction: EvalRunResult,
      reconcileResult: ReconcileEvalResult,
    ) => {
      const byLabel = new Map(reconcileResult.perLanguage.map((m) => [m.label, m]));
      return {
        id,
        label,
        description,
        extraction_cases: extraction.caseCount,
        reconcile_pairs: reconcileResult.pairCount,
        per_language: extraction.perLanguage.map((m) => {
          const r = byLabel.get(m.label);
          return {
            language: m.label,
            golden_cases: m.cases,
            reconcile_pairs: r ? r.dedupPairs + r.contradictionPairs : 0,
            extraction_precision: m.precision,
            extraction_recall: m.recall,
            verification_agreement: m.verificationAgreement,
            dedup_accuracy: r ? r.dedupAccuracy : null,
            contradiction_precision: r ? r.contradictionPrecision : null,
            contradiction_recall: r ? r.contradictionRecall : null,
            supersedes_accuracy: r ? r.supersedesAccuracy : null,
            supersedes_pairs: r ? r.supersedesPairs + r.supersedesFalsePositives : null,
          };
        }),
        aggregate: {
          extraction_precision: extraction.aggregate.precision,
          extraction_recall: extraction.aggregate.recall,
          verification_agreement: extraction.aggregate.verificationAgreement,
          dedup_accuracy: reconcileResult.aggregate.dedupAccuracy,
          contradiction_precision: reconcileResult.aggregate.contradictionPrecision,
          contradiction_recall: reconcileResult.aggregate.contradictionRecall,
          supersedes_accuracy: reconcileResult.aggregate.supersedesAccuracy,
          supersedes_pairs:
            reconcileResult.aggregate.supersedesPairs +
            reconcileResult.aggregate.supersedesFalsePositives,
        },
      };
    };
    emitPartial(emitPath, {
      schema_version: TRUST_SCORES_SCHEMA_VERSION,
      harness:
        `${result.promptVersions} · ${RECONCILE_DEDUP_PROMPT.family}/${RECONCILE_DEDUP_PROMPT.version} + ` +
        `${RECONCILE_CONTRADICTION_PROMPT.family}/${RECONCILE_CONTRADICTION_PROMPT.version} · ` +
        `${rewrite.promptVersion} · thresholds v${result.config.version}`,
      configuration: {
        id,
        models,
        redaction: redaction !== undefined,
        corpus: {
          golden_cases: result.caseCount,
          reconcile_pairs: reconcile.pairCount,
          rewrite_cases: rewrite.caseCount,
          per_language: result.perLanguage.map((m) => ({
            language: m.label,
            golden_cases: m.cases,
            reconcile_pairs:
              (reconcileByLabel.get(m.label)?.dedupPairs ?? 0) +
              (reconcileByLabel.get(m.label)?.contradictionPairs ?? 0),
            rewrite_cases: rewriteByLabel.get(m.label)?.cases ?? 0,
          })),
        },
        metrics: {
          per_language: result.perLanguage.map((m) => {
            const r = reconcileByLabel.get(m.label);
            const w = rewriteByLabel.get(m.label);
            return {
              language: m.label,
              golden_cases: m.cases,
              extraction_precision: m.precision,
              extraction_recall: m.recall,
              verification_agreement: m.verificationAgreement,
              dedup_accuracy: r ? r.dedupAccuracy : null,
              // Published from V2.0 item 3.4 on: measured all along, never
              // emitted, which made the published picture the flattering half.
              contradiction_precision: r ? r.contradictionPrecision : null,
              contradiction_recall: r ? r.contradictionRecall : null,
              supersedes_accuracy: r ? r.supersedesAccuracy : null,
              supersedes_pairs: r ? r.supersedesPairs + r.supersedesFalsePositives : null,
              rewrite_accuracy: w ? w.accuracy : null,
            };
          }),
          aggregate: {
            extraction_precision: result.aggregate.precision,
            extraction_recall: result.aggregate.recall,
            verification_agreement: result.aggregate.verificationAgreement,
            dedup_accuracy: reconcile.aggregate.dedupAccuracy,
            contradiction_precision: reconcile.aggregate.contradictionPrecision,
            contradiction_recall: reconcile.aggregate.contradictionRecall,
            supersedes_accuracy: reconcile.aggregate.supersedesAccuracy,
            supersedes_pairs:
              reconcile.aggregate.supersedesPairs + reconcile.aggregate.supersedesFalsePositives,
            rewrite_accuracy: rewrite.aggregate.accuracy,
          },
        },
        // Schema 1.2: the corpora side by side, never averaged. `metrics` and
        // `corpus` above still describe the CORE corpus alone, exactly as they
        // did in 1.1, so no published trend line moves.
        corpora: [
          corpusBlock(
            'core',
            'Notes, emails, web pages and document excerpts',
            'The corpus the engine was built against: quick captures, email threads, fetched pages and short document excerpts, grown case by case since v0.8.0 and hardened five times with deliberately difficult negatives.',
            result,
            reconcile,
          ),
          corpusBlock(
            'vertical',
            'Documents: regulatory guidance, standards, device datasheets, public tenders',
            'Real public documents of the type Cogeto is sold into, sourced whole and excerpted verbatim: an EU regulation and its amending act, two revisions of a security standard, two microcontroller datasheets that share their boilerplate, two public tender notices and one 1987 scan. Harder than the core corpus by construction, because it carries page furniture, flattened tables, registry metadata and OCR noise that a written fixture would not.',
            vertical,
            verticalReconcile,
          ),
        ],
      },
    });
    console.log(`trust-score partial emitted → ${emitPath}`);
  }

  // ── The spec §14 gates: aggregate metrics vs gates.json ───────
  // Always printed; enforced (exit 1) when COGETO_EVAL_GATE=1 — the CI mode
  // and `npm run eval:gate`. Ratchet up only; lowering needs a decision record.
  const {
    version: gatesVersion,
    gates,
    per_language: perLanguageGates,
    vertical: verticalGates,
  } = gatesSchema.parse(JSON.parse(await readFile(GATES_FILE, 'utf8')));

  /**
   * A language present in one corpus and not another scores the empty-arm
   * convention (1) for the missing arm rather than 0, matching the harness.
   */
  const emptyExtractionMetrics = (label: string): EvalMetrics => ({
    label,
    cases: 0,
    extractedFacts: 0,
    matchedExtracted: 0,
    mustExtractLabels: 0,
    matchedMustExtract: 0,
    precision: 1,
    recall: 1,
    verificationCases: 0,
    verificationAgreed: 0,
    verificationAgreement: 1,
    injectionViolations: 0,
    subjectMismatches: 0,
  });

  /** One language's (or the aggregate's) measured value for every gated metric. */
  const measuredFor = (
    extraction: EvalMetrics,
    reconcileMetrics: ReconcileEvalMetrics | undefined,
    rewriteMetrics: RewriteEvalMetrics | undefined,
  ): MetricFloors => ({
    extraction_precision: extraction.precision,
    extraction_recall: extraction.recall,
    verification_agreement: extraction.verificationAgreement,
    // A language with no pairs of a kind scores 1 by the harness's own
    // convention (an empty denominator is not a failure). The floors below
    // are set from what was actually measured, so an empty arm cannot lift a
    // floor above what the corpus supports.
    dedup_accuracy: reconcileMetrics?.dedupAccuracy ?? 1,
    contradiction_precision: reconcileMetrics?.contradictionPrecision ?? 1,
    contradiction_recall: reconcileMetrics?.contradictionRecall ?? 1,
    supersedes_accuracy: reconcileMetrics?.supersedesAccuracy ?? 1,
    rewrite_accuracy: rewriteMetrics?.accuracy ?? 1,
  });

  const reconcileByLang = new Map(reconcile.perLanguage.map((m) => [m.label, m]));
  const rewriteByLang = new Map(rewrite.perLanguage.map((m) => [m.label, m]));
  const measured = measuredFor(result.aggregate, reconcile.aggregate, rewrite.aggregate);
  const failures: string[] = [];
  console.log(`\n================== GATE CHECK (gates v${gatesVersion}) ==================`);
  console.log('  aggregate:');
  for (const [metric, gate] of Object.entries(gates)) {
    const value = measured[metric as keyof MetricFloors];
    const ok = value >= gate;
    if (!ok) failures.push(`${metric}: ${pct(value)} < gate ${pct(gate)}`);
    console.log(
      `    ${ok ? 'PASS' : 'FAIL'}  ${metric.padEnd(24)} ${pct(value)}  (gate ≥ ${pct(gate)})`,
    );
  }

  // Per-language floors (V2.0 item 3.4): an aggregate hides a weak language.
  // Croatian dedup sat at 83.3% under a 90% aggregate gate for eight releases
  // and nothing failed, because nothing looked.
  // The UNION of every language any arm reported, so a language that exists
  // only in the rewrite or reconciliation corpus is still gated.
  const goldenByLang = new Map(result.perLanguage.map((m) => [m.label, m]));
  const languages = [
    ...new Set([...goldenByLang.keys(), ...reconcileByLang.keys(), ...rewriteByLang.keys()]),
  ].sort();
  for (const label of languages) {
    const floors = perLanguageGates[label];
    console.log(`  ${label}:`);
    if (!floors) {
      failures.push(
        `${label}: no per-language floors in gates.json (an ungated language is the hole these floors close)`,
      );
      console.log(`    FAIL  no floors configured for this language`);
      continue;
    }
    const langMeasured = measuredFor(
      goldenByLang.get(label) ?? emptyExtractionMetrics(label),
      reconcileByLang.get(label),
      rewriteByLang.get(label),
    );
    for (const [metric, gate] of Object.entries(floors)) {
      const value = langMeasured[metric as keyof MetricFloors];
      const ok = value >= gate;
      if (!ok) failures.push(`${label}.${metric}: ${pct(value)} < gate ${pct(gate)}`);
      console.log(
        `    ${ok ? 'PASS' : 'FAIL'}  ${metric.padEnd(24)} ${pct(value)}  (gate ≥ ${pct(gate)})`,
      );
    }
  }
  // ── The vertical corpus's own floors (V2.3 item 6.4) ───────────
  // Its own block, never averaged into the aggregate above. The floors are
  // LOWER than the core corpus's and that is expected: real documents carry
  // page furniture, flattened tables and registry metadata that a written
  // fixture does not. Same governing rule either way (docs/eval/gate-model.md):
  // publish everything measured, gate at the honest current value, ratchet up
  // only, never gate at a target the project is below.
  const verticalReconcileByLang = new Map(verticalReconcile.perLanguage.map((m) => [m.label, m]));
  const verticalGoldenByLang = new Map(vertical.perLanguage.map((m) => [m.label, m]));
  const verticalMeasuredFor = (
    extraction: EvalMetrics,
    reconcileMetrics: ReconcileEvalMetrics | undefined,
  ): VerticalFloors => ({
    extraction_precision: extraction.precision,
    extraction_recall: extraction.recall,
    verification_agreement: extraction.verificationAgreement,
    dedup_accuracy: reconcileMetrics?.dedupAccuracy ?? 1,
    contradiction_precision: reconcileMetrics?.contradictionPrecision ?? 1,
    contradiction_recall: reconcileMetrics?.contradictionRecall ?? 1,
    supersedes_accuracy: reconcileMetrics?.supersedesAccuracy ?? 1,
  });
  console.log('  vertical corpus (documents), aggregate:');
  const verticalAggregateMeasured = verticalMeasuredFor(
    vertical.aggregate,
    verticalReconcile.aggregate,
  );
  for (const [metric, gate] of Object.entries(verticalGates.gates)) {
    const value = verticalAggregateMeasured[metric as keyof VerticalFloors];
    const ok = value >= gate;
    if (!ok) failures.push(`vertical.${metric}: ${pct(value)} < gate ${pct(gate)}`);
    console.log(
      `    ${ok ? 'PASS' : 'FAIL'}  ${metric.padEnd(24)} ${pct(value)}  (gate ≥ ${pct(gate)})`,
    );
  }
  // Same union rule as the core corpus: a set the harness measures and
  // gates.json does not name FAILS. The vertical corpus adds `xl`, the
  // cross-language pair set, which is a measured set like any other.
  const verticalSets = [
    ...new Set([...verticalGoldenByLang.keys(), ...verticalReconcileByLang.keys()]),
  ].sort();
  for (const label of verticalSets) {
    const floors = verticalGates.per_language[label];
    console.log(`  vertical.${label}:`);
    if (!floors) {
      failures.push(
        `vertical.${label}: no floors in gates.json (an ungated set is the hole these floors close)`,
      );
      console.log(`    FAIL  no floors configured for this set`);
      continue;
    }
    const measuredSet = verticalMeasuredFor(
      verticalGoldenByLang.get(label) ?? emptyExtractionMetrics(label),
      verticalReconcileByLang.get(label),
    );
    for (const [metric, gate] of Object.entries(floors)) {
      const value = measuredSet[metric as keyof VerticalFloors];
      const ok = value >= gate;
      if (!ok) failures.push(`vertical.${label}.${metric}: ${pct(value)} < gate ${pct(gate)}`);
      console.log(
        `    ${ok ? 'PASS' : 'FAIL'}  ${metric.padEnd(24)} ${pct(value)}  (gate ≥ ${pct(gate)})`,
      );
    }
  }

  // Injection traps (audit 2.0 SEC-4) are a ZERO-TOLERANCE gate, not a
  // threshold: a violation means a model obeyed text inside the untrusted-data
  // fence and a hostile document wrote a memory. There is no acceptable rate.
  const injections = result.aggregate.injectionViolations;
  const injectionsOk = injections === 0;
  if (!injectionsOk) failures.push(`injection_violations: ${injections} (must be 0)`);
  console.log(
    `  ${injectionsOk ? 'PASS' : 'FAIL'}  ${'injection_violations'.padEnd(24)} ${injections}  (gate = 0)`,
  );
  // Subject traps (issue #313) are likewise ZERO-TOLERANCE: the reconciliation
  // candidate gate keys on exact subject equality, so a drifted subject
  // silently disables contradiction and supersession detection while every
  // similarity metric still passes. Only cases that DECLARE a subject count.
  const subjectMisses = result.aggregate.subjectMismatches;
  const subjectsOk = subjectMisses === 0;
  if (!subjectsOk) failures.push(`subject_mismatches: ${subjectMisses} (must be 0)`);
  console.log(
    `  ${subjectsOk ? 'PASS' : 'FAIL'}  ${'subject_mismatches'.padEnd(24)} ${subjectMisses}  (gate = 0)`,
  );
  // Both zero-tolerance gates apply to the vertical corpus too, counted
  // separately so a breach names the corpus it came from. Subject drift is
  // WHY the vertical corpus can measure anything at all: the same-boilerplate
  // datasheets and the same-template tender lots are told apart only by their
  // anchored subject, so a drifted subject turns every negative pair into a
  // false finding and every positive merge into a miss, from one root cause.
  const verticalInjections = vertical.aggregate.injectionViolations;
  if (verticalInjections !== 0) {
    failures.push(`vertical.injection_violations: ${verticalInjections} (must be 0)`);
  }
  console.log(
    `  ${verticalInjections === 0 ? 'PASS' : 'FAIL'}  ${'vertical.injections'.padEnd(24)} ${verticalInjections}  (gate = 0)`,
  );
  const verticalSubjectMisses = vertical.aggregate.subjectMismatches;
  if (verticalSubjectMisses !== 0) {
    failures.push(`vertical.subject_mismatches: ${verticalSubjectMisses} (must be 0)`);
  }
  console.log(
    `  ${verticalSubjectMisses === 0 ? 'PASS' : 'FAIL'}  ${'vertical.subject_misses'.padEnd(24)} ${verticalSubjectMisses}  (gate = 0)`,
  );
  console.log('===========================================================\n');

  if (cacheMode === 'record' && cacheStore) {
    cacheStore.flush({
      scoring_version: EVAL_SCORING_VERSION,
      configuration_id: providers.id,
      models: configurationForEmission(providers).models,
      recorded_at: new Date().toISOString(),
    });
    console.log(
      `eval cache recorded: ${cacheStore.sizes.text} responses + ${cacheStore.sizes.embeddings} embeddings → ${path.relative(REPO_ROOT, CACHE_DIR)}`,
    );
  }
  if (cacheMode === 'replay') {
    console.log(
      'cached run: catches prompt / pipeline / scoring regressions. Model-side drift is caught ' +
        'only by the LIVE post-merge gate, which is also the only source of published numbers.',
    );
  }

  // A replay miss FAILS the run even when the caller swallowed the error
  // (`rewriteQuery` catches everything by design). A partial run reported as
  // green is the false green this mechanism exists to prevent.
  if (cacheMode === 'replay' && cacheStore && cacheStore.misses > 0) {
    console.error(
      `eval cache: ${cacheStore.misses} MISS(ES). The fixtures do not cover this code. ` +
        `Refresh them with: npm run eval:cache:refresh`,
    );
    process.exitCode = 1;
  }

  if (failures.length > 0) {
    console.error(`GATE BREACH: ${failures.join('; ')}`);
    if (process.env.COGETO_EVAL_GATE === '1') {
      console.error('failing the build (spec §14: regressions fail the build)');
      process.exitCode = 1;
    } else {
      console.error('advisory run (set COGETO_EVAL_GATE=1 to enforce)');
    }
  }
}

main().catch((error: unknown) => {
  console.error('eval failed:', error);
  process.exit(1);
});
