import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { evalConfigSchema, runGoldenEval, runReconcileEval } from '../ingestion/index';
import type { EvalMetrics, ReconcileEvalMetrics } from '../ingestion/index';
import { MistralModelGateway } from '../model-gateway/index';

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
const HISTORY_FILE = path.join(REPO_ROOT, 'docs', 'eval', 'history.md');

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
  const gateway = new MistralModelGateway({
    apiKey,
    embedModel: process.env.COGETO_MISTRAL_EMBED_MODEL || process.env.MISTRAL_EMBED_MODEL,
  });

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

  await mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  await appendFile(
    HISTORY_FILE,
    `\n## ${stamp} — ${result.promptVersions} (thresholds v${result.config.version}, ${result.caseCount} cases)\n\n${table}\n` +
      `\n## ${stamp} — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v${reconcile.configVersion}, ${reconcile.pairCount} pairs)\n\n${reconcileTable}\n`,
    'utf8',
  );
  console.log(`appended to ${path.relative(REPO_ROOT, HISTORY_FILE)}`);
}

main().catch((error: unknown) => {
  console.error('eval failed:', error);
  process.exit(1);
});
