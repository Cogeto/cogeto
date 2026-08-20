import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

/**
 * model_config_env: the environment cannot configure models.
 *
 * The one-time seeding bridge is deleted (deployment-readiness remediation):
 * on a running instance the DATABASE is the only source of model
 * configuration, written through the interface. These tests pin that down two
 * ways — behaviourally (a stale model variable in `.env` changes nothing) and
 * structurally (no instance code path references the retired variables; the
 * eval harness and the dev smoke tool are the sanctioned, allowlisted
 * exceptions because they run against no instance database).
 */

const validEnv = {
  COGETO_DATABASE_URL: 'postgres://postgres:dev@localhost:5432/cogeto',
  COGETO_QDRANT_URL: 'http://localhost:6333',
  COGETO_S3_URL: 'http://localhost:9000',
  COGETO_OIDC_ISSUER: 'https://localhost',
  COGETO_OIDC_INTERNAL_URL: 'http://localhost:8080',
  COGETO_OIDC_EXTERNAL_DOMAIN: 'localhost',
  COGETO_WEB_CONFIG_FILE: '/web-config/config.json',
};

/**
 * Every retired model variable, holding a unique sentinel so the leak check
 * below can look for the VALUES: none may surface anywhere in the resolved
 * configuration. Real-looking values are beside the point; nothing parses
 * them any more, and that is exactly the property under test.
 */
const STALE_MODEL_ENV = {
  COGETO_MISTRAL_API_KEY: 'stale-mistral-key',
  COGETO_MISTRAL_MODEL_PIPELINE: 'stale-mistral-pipeline-model',
  COGETO_MISTRAL_MODEL_ANSWER: 'stale-mistral-answer-model',
  COGETO_MISTRAL_EMBED_MODEL: 'stale-mistral-embed-model',
  COGETO_PROVIDER_PRESET: 'stale-preset',
  COGETO_PROVIDER_PIPELINE: 'stale-pipeline-provider',
  COGETO_MODEL_PIPELINE: 'stale-pipeline-model',
  COGETO_PROVIDER_ANSWER: 'stale-answer-provider',
  COGETO_MODEL_ANSWER: 'stale-answer-model',
  COGETO_PROVIDER_EMBEDDINGS: 'stale-embeddings-provider',
  COGETO_MODEL_EMBEDDINGS: 'stale-embeddings-model',
  COGETO_PROVIDER_VISION: 'stale-vision-provider',
  COGETO_MODEL_VISION: 'stale-vision-model',
  COGETO_OPENAI_API_KEY: 'stale-openai-key',
  COGETO_OPENAI_BASE_URL: 'http://stale-openai.invalid/v1',
  COGETO_ANTHROPIC_API_KEY: 'stale-anthropic-key',
  COGETO_ANTHROPIC_BASE_URL: 'http://stale-anthropic.invalid',
  COGETO_OLLAMA_BASE_URL: 'http://stale-ollama.invalid:11434',
  COGETO_OLLAMA_API_KEY: 'stale-ollama-key',
  MISTRAL_API_KEY: 'stale-prefixless-key',
  MISTRAL_MODEL_PIPELINE: 'stale-prefixless-pipeline-model',
  MISTRAL_MODEL_ANSWER: 'stale-prefixless-answer-model',
  MISTRAL_EMBED_MODEL: 'stale-prefixless-embed-model',
};

describe('model_config_env: a stale model variable has no effect', () => {
  it('boots unconfigured regardless of what model variables the environment holds', () => {
    const config = loadConfig({ ...validEnv, ...STALE_MODEL_ENV });
    expect(config.modelProviders.configured).toBe(false);
    expect(config.modelProviders.id).toBe('unconfigured');
    expect(config.modelProviders.source).toBe('none');
    expect(config.modelProviders.keys).toEqual({});
    expect(config.modelProviders.vision).toBeNull();
    expect(config.modelProviders.ollama).toBeNull();
    // Not a single stale value leaks into the resolved shape.
    const serialized = JSON.stringify(config.modelProviders);
    for (const value of Object.values(STALE_MODEL_ENV)) {
      expect(serialized).not.toContain(value);
    }
  });

  it('resolves identically with and without the stale variables', () => {
    const withStale = loadConfig({ ...validEnv, ...STALE_MODEL_ENV });
    const without = loadConfig(validEnv);
    expect(withStale.modelProviders).toEqual(without.modelProviders);
  });

  it('still reads the live runtime knobs (timeouts, headroom) from the environment', () => {
    const config = loadConfig({
      ...validEnv,
      COGETO_MODEL_TIMEOUT_ANSWER_MS: '450000',
      COGETO_MODEL_TIMEOUT_PIPELINE_MS: '360000',
      COGETO_REASONING_HEADROOM: '8',
    });
    expect(config.modelProviders.timeoutsMs.answer).toBe(450_000);
    expect(config.modelProviders.timeoutsMs.pipeline).toBe(360_000);
    expect(config.modelProviders.reasoningHeadroom).toBe(8);
  });
});

/**
 * Structural confinement. The retired variable names may appear ONLY where
 * the eval harness's environment resolver lives; everything else in
 * project/src must be free of them, so no instance path can grow a quiet
 * fallback. Spec files are excluded (they exercise the eval resolver and
 * this very list).
 */
const SRC = process.cwd();

const EVAL_ONLY_FILES = new Set([
  // The eval resolver itself: variable names are its input surface.
  path.join(SRC, 'model-gateway', 'provider-config.ts'),
  // The harness front doors that call it (or document its variables).
  path.join(SRC, 'entrypoints', 'eval-env.ts'),
  path.join(SRC, 'entrypoints', 'eval.ts'),
  path.join(SRC, 'entrypoints', 'eval-chat.ts'),
  path.join(SRC, 'entrypoints', 'gateway-smoke.ts'),
]);

const RETIRED_NAMES = [
  'COGETO_MISTRAL_API_KEY',
  'COGETO_MISTRAL_MODEL_PIPELINE',
  'COGETO_MISTRAL_MODEL_ANSWER',
  'COGETO_MISTRAL_EMBED_MODEL',
  'COGETO_PROVIDER_PRESET',
  'COGETO_PROVIDER_PIPELINE',
  'COGETO_PROVIDER_ANSWER',
  'COGETO_PROVIDER_EMBEDDINGS',
  'COGETO_PROVIDER_VISION',
  'COGETO_MODEL_PIPELINE',
  'COGETO_MODEL_ANSWER',
  'COGETO_MODEL_EMBEDDINGS',
  'COGETO_MODEL_VISION',
  'COGETO_OPENAI_API_KEY',
  'COGETO_OPENAI_BASE_URL',
  'COGETO_ANTHROPIC_API_KEY',
  'COGETO_ANTHROPIC_BASE_URL',
  'COGETO_OLLAMA_API_KEY',
  'COGETO_OLLAMA_BASE_URL',
  // The pre-1.0 unprefixed fallbacks (audit F20) are gone everywhere,
  // including the eval resolver.
  'MISTRAL_API_KEY',
  'MISTRAL_MODEL_PIPELINE',
  'MISTRAL_MODEL_ANSWER',
  'MISTRAL_EMBED_MODEL',
];

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, acc);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) acc.push(full);
  }
  return acc;
}

describe('model_config_env: structural confinement', () => {
  const files = walkTs(SRC);

  it('no instance code references a retired model variable', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (EVAL_ONLY_FILES.has(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const name of RETIRED_NAMES) {
        // Word-boundary match so COGETO_MODEL_ANSWER does not hit
        // COGETO_MODEL_ANSWER_TIMEOUT-style names and vice versa.
        if (new RegExp(`\\b${name}\\b`).test(text)) {
          offenders.push(`${path.relative(SRC, file)}: ${name}`);
        }
      }
    }
    expect(offenders, `retired model variables referenced:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the unprefixed MISTRAL_* fallbacks are gone from the eval resolver too (F20)', () => {
    for (const file of EVAL_ONLY_FILES) {
      const text = readFileSync(file, 'utf8');
      for (const name of [
        'MISTRAL_API_KEY',
        'MISTRAL_MODEL_PIPELINE',
        'MISTRAL_MODEL_ANSWER',
        'MISTRAL_EMBED_MODEL',
      ]) {
        // The COGETO_-prefixed forms remain the eval resolver's input; only
        // the bare names are forbidden.
        expect(
          new RegExp(`(?<!COGETO_)\\b${name}\\b`).test(text),
          `${path.relative(SRC, file)} still reads unprefixed ${name}`,
        ).toBe(false);
      }
    }
  });

  it('the eval resolver is imported only by the harness front doors', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('resolveEvalProvidersFromEnv')) continue;
      const allowed =
        EVAL_ONLY_FILES.has(file) || file === path.join(SRC, 'model-gateway', 'index.ts');
      if (!allowed) offenders.push(path.relative(SRC, file));
    }
    expect(offenders, `unexpected consumers of the eval resolver: ${offenders.join(', ')}`).toEqual(
      [],
    );
  });
});

/**
 * THE ONE SANCTIONED EXCEPTION (hosted provisioning, task A): a conscious,
 * narrow walk-back of the rule this file exists to prove. A hosting platform
 * provisions instances unattended, so exactly ONE provider row per instance
 * may be MANAGED, reconciled at boot from `COGETO_MANAGED_PROVIDER_FILE`
 * (a platform-rendered file) plus `COGETO_MANAGED_PROVIDER_API_KEY`.
 *
 * The amendment permits exactly that path and continues to forbid everything
 * else:
 *
 *  - the two managed variables are read in ONE file, the boot step both
 *    composition roots call, and nowhere else, so no second consumer can
 *    grow;
 *  - `loadConfig` itself still ignores them (the reconciler is a separate,
 *    explicit boot step that refuses on a half-present configuration rather
 *    than resolving anything from it);
 *  - every retired model variable stays retired, every rule above stays
 *    byte-identical, and an instance without the managed configuration is
 *    untouched.
 */
const MANAGED_VARS = ['COGETO_MANAGED_PROVIDER_FILE', 'COGETO_MANAGED_PROVIDER_API_KEY'];
const MANAGED_BOOT_FILE = path.join(SRC, 'entrypoints', 'managed-provider-boot.ts');

describe('model_config_env: the managed path is the only environment exception', () => {
  it('the managed variables are read only by the managed boot step', () => {
    // The reconciler's refusal messages NAME the variables (a refusal must
    // say what is missing), so those two files may mention them; the module
    // is separately forbidden from reading the environment at all, asserted
    // below, so a mention there can never become a read.
    const mayName = new Set([
      MANAGED_BOOT_FILE,
      path.join(SRC, 'providers', 'managed-reconcile.ts'),
      path.join(SRC, 'providers', 'domain', 'managed-config.ts'),
    ]);
    const offenders: string[] = [];
    for (const file of walkTs(SRC)) {
      if (mayName.has(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const name of MANAGED_VARS) {
        if (new RegExp(`\\b${name}\\b`).test(text)) {
          offenders.push(`${path.relative(SRC, file)}: ${name}`);
        }
      }
    }
    expect(
      offenders,
      `managed variables referenced outside the boot step:\n${offenders.join('\n')}`,
    ).toEqual([]);
    const bootStep = readFileSync(MANAGED_BOOT_FILE, 'utf8');
    for (const name of MANAGED_VARS) expect(bootStep).toContain(name);
    // The two providers-module files never touch the environment: only
    // entrypoints read it, and the boot step hands the values in.
    for (const file of ['managed-reconcile.ts', path.join('domain', 'managed-config.ts')]) {
      expect(readFileSync(path.join(SRC, 'providers', file), 'utf8')).not.toContain('process.env');
    }
  });

  it('loadConfig still ignores the managed variables entirely', () => {
    const withManaged = loadConfig({
      ...validEnv,
      COGETO_MANAGED_PROVIDER_FILE: '/nonexistent/managed.json',
      COGETO_MANAGED_PROVIDER_API_KEY: 'stale-managed-key',
    });
    const without = loadConfig(validEnv);
    expect(withManaged.modelProviders).toEqual(without.modelProviders);
    expect(JSON.stringify(withManaged.modelProviders)).not.toContain('stale-managed-key');
  });
});
