import type { LimitsConfig } from '../infrastructure/index';

/**
 * Resolve the effective abuse/DoS limits (FIX-2: QS-2, QS-6, QS-14) once at
 * boot from the environment, with sane defaults, TIGHTENED automatically when
 * the instance is the anonymous Ana sandbox (`demoMode`), where a single
 * published token is shared by every visitor (decision 0022).
 *
 * Every limit is env-configurable; the demo profile has its own override
 * namespace (`COGETO_DEMO_*`) so the public sandbox can be capped without
 * touching a customer instance's values. Defaults are generous for a real user
 * and only bite runaway loops / anonymous abuse. A rate-limit bucket of 0 is
 * unlimited. The type definitions live in infrastructure so the guards can
 * enforce them without importing an entrypoint.
 */

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid numeric limit '${value}' (must be a non-negative number)`);
  }
  return parsed;
}

/**
 * Env vars are read by static dot-access below (not a dynamic lookup) so the
 * env_consistency test tracks every one and it stays documented in .env.example.
 */
export function buildLimits(env: NodeJS.ProcessEnv, demoMode: boolean): LimitsConfig {
  // Pick base vs demo from already-read values: in demo mode the demo override
  // wins, then the base, then the (aggressive) demo default.
  const pick = (
    baseVal: string | undefined,
    demoVal: string | undefined,
    baseDefault: number,
    demoDefault: number,
  ): number => (demoMode ? num(demoVal ?? baseVal, demoDefault) : num(baseVal, baseDefault));

  return {
    rateLimit: {
      windowSeconds: num(env.COGETO_RATELIMIT_WINDOW_SECONDS, 60),
      // Chat is the model-cost vector the audit calls out (QS-2): tightest.
      chat: pick(env.COGETO_RATELIMIT_CHAT, env.COGETO_DEMO_RATELIMIT_CHAT, 30, 12),
      // Capture must clear the demo seed's 31-note burst (paced by processing).
      capture: pick(env.COGETO_RATELIMIT_CAPTURE, env.COGETO_DEMO_RATELIMIT_CAPTURE, 60, 60),
      remember: pick(env.COGETO_RATELIMIT_REMEMBER, env.COGETO_DEMO_RATELIMIT_REMEMBER, 30, 15),
      upload: pick(env.COGETO_RATELIMIT_UPLOAD, env.COGETO_DEMO_RATELIMIT_UPLOAD, 20, 10),
    },
    modelBudget: {
      dailyCalls: pick(env.COGETO_MODEL_DAILY_CALLS, env.COGETO_DEMO_MODEL_DAILY_CALLS, 2000, 400),
      dailyTokens: pick(
        env.COGETO_MODEL_DAILY_TOKENS,
        env.COGETO_DEMO_MODEL_DAILY_TOKENS,
        4_000_000,
        800_000,
      ),
    },
    ingestQuota: {
      // Demo cap must exceed the seed (31 notes) plus a day of visitor captures.
      captureMax: pick(env.COGETO_DAILY_CAPTURE_MAX, env.COGETO_DEMO_DAILY_CAPTURE_MAX, 1000, 500),
      uploadMax: pick(env.COGETO_DAILY_UPLOAD_MAX, env.COGETO_DEMO_DAILY_UPLOAD_MAX, 300, 100),
    },
    sse: {
      maxConcurrentPerPrincipal: pick(
        env.COGETO_SSE_MAX_CONCURRENT,
        env.COGETO_DEMO_SSE_MAX_CONCURRENT,
        3,
        2,
      ),
      idleTimeoutSeconds: num(env.COGETO_SSE_IDLE_TIMEOUT_SECONDS, 60),
      maxDurationSeconds: num(env.COGETO_SSE_MAX_DURATION_SECONDS, 180),
    },
    parse: {
      maxTextChars: num(env.COGETO_PARSE_MAX_TEXT_CHARS, 1_000_000),
      maxChunks: num(env.COGETO_PARSE_MAX_CHUNKS, 200),
      timeoutSeconds: num(env.COGETO_PARSE_TIMEOUT_SECONDS, 30),
      maxFacts: num(env.COGETO_EXTRACT_MAX_FACTS, 100),
    },
  };
}
