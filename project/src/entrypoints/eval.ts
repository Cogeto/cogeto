import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { evalConfigSchema, runGoldenEval, runReconcileEval } from '../ingestion/index';
import type { EvalMetrics, ReconcileEvalMetrics } from '../ingestion/index';
import { runTaskEval } from '../tasks/index';
import type { TaskEvalMetrics } from '../tasks/index';
import { createModelGateway } from '../model-gateway/index';
import { redactionFromEnv } from './config';
import { DEFAULT_MODELS, deriveConfigurationId, emitPartial } from './trust-scores';
import { TRUST_SCORES_SCHEMA_VERSION } from './trust-scores';

/**
 * npm run eval — the golden-set harness (§B.4; docs/eval-golden-set.md) against
 * the live gateway. Prints per-language + aggregate metrics prominently and
 * appends them, with prompt versions, to docs/eval/history.md. No CI gates yet
 * (Session 4 turns them on).
 *
 * Needs only an API key: MISTRAL_API_KEY / COGETO_MISTRAL_API_KEY in the env,
 * or in the repo-root .env.
 */

// dist layout: project/src/dist/entrypoints → repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const GOLDEN_DIR = path.join(REPO_ROOT, 'project', 'eval', 'golden');
const CONFIG_FILE = path.join(REPO_ROOT, 'project', 'eval', 'eval-config.json');
const GATES_FILE = path.join(REPO_ROOT, 'project', 'eval', 'gates.json');
const HISTORY_FILE = path.join(REPO_ROOT, 'docs', 'eval', 'history.md');

/** The §B.4 CI gates (decision 0011): aggregate metrics, ratchet-up-only. */
const gatesSchema = z.object({
  version: z.number(),
  gates: z.object({
    extraction_precision: z.number(),
    extraction_recall: z.number(),
    verification_agreement: z.number(),
    dedup_accuracy: z.number(),
    contradiction_recall: z.number(),
  }),
});

async function resolveApiKey(): Promise<string | undefined> {
  const fromEnv = process.env.COGETO_MISTRAL_API_KEY || process.env.MISTRAL_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    const dotenv = await readFile(path.join(REPO_ROOT, '.env'), 'utf8');
    const match = dotenv.match(/^(?:COGETO_)?MISTRAL_API_KEY=(.+)$/m);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

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
    `| ${m.supersedesPairs ? `${m.supersedesCorrect}/${m.supersedesPairs}` : '—'} ` +
    `| ${m.candidateMisses} |`
  );
}

async function main(): Promise<void> {
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    console.error('eval needs MISTRAL_API_KEY (env or repo-root .env) — the harness is live-only');
    process.exit(2);
  }
  const config = evalConfigSchema.parse(JSON.parse(await readFile(CONFIG_FILE, 'utf8')));
  const redaction = redactionFromEnv();
  const gateway = createModelGateway({
    mistralApiKey: apiKey,
    embedModel: process.env.COGETO_MISTRAL_EMBED_MODEL || process.env.MISTRAL_EMBED_MODEL,
    redaction,
    // Deterministic sampling for comparable runs (decision 0035).
    temperature: 0,
  });
  if (redaction) console.log(`redaction: ON (sidecar ${redaction.url}) — measuring the delta`);

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

  // Reconciliation pair cases (F2-A, decision 0010 ruling 9) — the same run,
  // so the trust score always reports extraction and reconciliation together.
  console.log('reconciliation pairs:');
  const reconcile = await runReconcileEval({
    gateway,
    goldenDir: GOLDEN_DIR,
    log: (message) => console.log(`  ${message}`),
  });
  const reconcileTable = [
    '| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |',
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

  // Task-judgment pairs (F3-B, decision 0013 ruling 3) — same run, same
  // trust-score page.
  console.log('task pairs:');
  const taskEval = await runTaskEval({
    gateway,
    goldenDir: GOLDEN_DIR,
    log: (message) => console.log(`  ${message}`),
  });
  const taskRow = (m: TaskEvalMetrics): string =>
    `| ${m.label} | ${m.closurePairs} | ${pct(m.closureAccuracy)} (${m.closureEarned}/${m.closureWeight}` +
    `${m.falseClosures ? `, ${m.falseClosures} FALSE CLOSE${m.falseClosures > 1 ? 'S' : ''}` : ''}) ` +
    `| ${m.conditionPairs} | ${pct(m.conditionAccuracy)} (${m.conditionCorrect}/${m.conditionPairs}) |`;
  const taskTable = [
    '| set | closure pairs | closure accuracy | condition pairs | condition accuracy |',
    '|---|---|---|---|---|',
    ...taskEval.perLanguage.map(taskRow),
    taskRow(taskEval.aggregate),
  ].join('\n');
  console.log('\n================= TASK PAIR RESULTS =================');
  console.log(`prompts: task_closure/v0001 + task_condition/v0001 · ${taskEval.pairCount} pairs`);
  console.log(taskTable);
  console.log('=====================================================\n');

  await mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  await appendFile(
    HISTORY_FILE,
    `\n## ${stamp} — ${result.promptVersions} (thresholds v${result.config.version}, ${result.caseCount} cases)\n\n${table}\n` +
      `\n## ${stamp} — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v${reconcile.configVersion}, ${reconcile.pairCount} pairs)\n\n${reconcileTable}\n` +
      `\n## ${stamp} — task_closure/v0001 + task_condition/v0001 (${taskEval.pairCount} pairs)\n\n${taskTable}\n`,
    'utf8',
  );
  console.log(`appended to ${path.relative(REPO_ROOT, HISTORY_FILE)}`);

  // ── Trust-score emission (O7, decision 0032): --emit-json <path> ─────────
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
    const models = {
      pipeline:
        process.env.COGETO_MISTRAL_MODEL_PIPELINE ||
        process.env.MISTRAL_MODEL_PIPELINE ||
        DEFAULT_MODELS.pipeline,
      answer:
        process.env.COGETO_MISTRAL_MODEL_ANSWER ||
        process.env.MISTRAL_MODEL_ANSWER ||
        DEFAULT_MODELS.answer,
      embedding:
        process.env.COGETO_MISTRAL_EMBED_MODEL ||
        process.env.MISTRAL_EMBED_MODEL ||
        DEFAULT_MODELS.embedding,
    };
    const reconcileByLabel = new Map(reconcile.perLanguage.map((m) => [m.label, m]));
    emitPartial(emitPath, {
      schema_version: TRUST_SCORES_SCHEMA_VERSION,
      harness: `${result.promptVersions} · reconcile_dedup/v0001 + reconcile_contradiction/v0001 · thresholds v${result.config.version}`,
      configuration: {
        id: deriveConfigurationId(models),
        models,
        redaction: redaction !== undefined,
        corpus: {
          golden_cases: result.caseCount,
          reconcile_pairs: reconcile.pairCount,
          per_language: result.perLanguage.map((m) => ({
            language: m.label,
            golden_cases: m.cases,
          })),
        },
        metrics: {
          per_language: result.perLanguage.map((m) => {
            const r = reconcileByLabel.get(m.label);
            return {
              language: m.label,
              golden_cases: m.cases,
              extraction_precision: m.precision,
              extraction_recall: m.recall,
              verification_agreement: m.verificationAgreement,
              dedup_accuracy: r ? r.dedupAccuracy : null,
              contradiction_recall: r ? r.contradictionRecall : null,
            };
          }),
          aggregate: {
            extraction_precision: result.aggregate.precision,
            extraction_recall: result.aggregate.recall,
            verification_agreement: result.aggregate.verificationAgreement,
            dedup_accuracy: reconcile.aggregate.dedupAccuracy,
            contradiction_recall: reconcile.aggregate.contradictionRecall,
          },
        },
      },
    });
    console.log(`trust-score partial emitted → ${emitPath}`);
  }

  // ── The §B.4 gates (decision 0011): aggregate metrics vs gates.json ───────
  // Always printed; enforced (exit 1) when COGETO_EVAL_GATE=1 — the CI mode
  // and `npm run eval:gate`. Ratchet up only; lowering needs a decision record.
  const { version: gatesVersion, gates } = gatesSchema.parse(
    JSON.parse(await readFile(GATES_FILE, 'utf8')),
  );
  const measured = {
    extraction_precision: result.aggregate.precision,
    extraction_recall: result.aggregate.recall,
    verification_agreement: result.aggregate.verificationAgreement,
    dedup_accuracy: reconcile.aggregate.dedupAccuracy,
    contradiction_recall: reconcile.aggregate.contradictionRecall,
  };
  const failures: string[] = [];
  console.log(`\n================== GATE CHECK (gates v${gatesVersion}) ==================`);
  for (const [metric, gate] of Object.entries(gates)) {
    const value = measured[metric as keyof typeof measured];
    const ok = value >= gate;
    if (!ok) failures.push(`${metric}: ${pct(value)} < gate ${pct(gate)}`);
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${metric.padEnd(24)} ${pct(value)}  (gate ≥ ${pct(gate)})`,
    );
  }
  console.log('===========================================================\n');
  if (failures.length > 0) {
    console.error(`GATE BREACH: ${failures.join('; ')}`);
    if (process.env.COGETO_EVAL_GATE === '1') {
      console.error('failing the build (§B.4: regressions fail the build)');
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
