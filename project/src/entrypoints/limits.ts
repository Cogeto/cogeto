import type { LimitsConfig } from '../infrastructure/index';

/**
 * Resolve the effective abuse/DoS limits (:) once at
 * boot from the environment, with sane defaults, TIGHTENED automatically when
 * the instance is the anonymous Ana sandbox (`demoMode`), where a single
 * published token is shared by every visitor.
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
 * env_consistency test tracks every one and it stays documented in.env.example.
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
      // Chat is the model-cost vector the audit calls out: tightest.
      chat: pick(env.COGETO_RATELIMIT_CHAT, env.COGETO_DEMO_RATELIMIT_CHAT, 30, 12),
      // Capture must clear the demo seed's 31-note burst (paced by processing).
      capture: pick(env.COGETO_RATELIMIT_CAPTURE, env.COGETO_DEMO_RATELIMIT_CAPTURE, 60, 60),
      remember: pick(env.COGETO_RATELIMIT_REMEMBER, env.COGETO_DEMO_RATELIMIT_REMEMBER, 30, 15),
      upload: pick(env.COGETO_RATELIMIT_UPLOAD, env.COGETO_DEMO_RATELIMIT_UPLOAD, 20, 10),
    },
    modelBudget: {
      // Security audit 2.0 SEC-10: the budget now covers WORKER traffic too
      // (extraction, verification, embedding, dreaming, skill advance,
      // research conclusion), which used to run with no ceiling at all. The
      // defaults are raised to match what the budget now counts, sized off the
      // ingest quota rather than off interactive use: 1000 captures + 300
      // uploads a day, each driving a handful of pipeline calls, is roughly
      // 10k calls for a user who maxes out every other limit — so 10k is a
      // real ceiling that a legitimate day never reaches. The per-minute rate
      // limits, not this number, are what bound interactive abuse.
      dailyCalls: pick(
        env.COGETO_MODEL_DAILY_CALLS,
        env.COGETO_DEMO_MODEL_DAILY_CALLS,
        10_000,
        2000,
      ),
      dailyTokens: pick(
        env.COGETO_MODEL_DAILY_TOKENS,
        env.COGETO_DEMO_MODEL_DAILY_TOKENS,
        20_000_000,
        4_000_000,
      ),
    },
    ingestQuota: {
      // Demo cap must exceed the seed (31 notes) plus a day of visitor captures.
      captureMax: pick(env.COGETO_DAILY_CAPTURE_MAX, env.COGETO_DEMO_DAILY_CAPTURE_MAX, 1000, 500),
      uploadMax: pick(env.COGETO_DAILY_UPLOAD_MAX, env.COGETO_DEMO_DAILY_UPLOAD_MAX, 300, 100),
    },
    researchQuota: {
      // Web research: searches and fetched
      // pages are the two cost/abuse vectors — each capped per user per day,
      // plus a per-request page cap so one research stays bounded.
      searchesMax: pick(
        env.COGETO_DAILY_RESEARCH_SEARCHES,
        env.COGETO_DEMO_DAILY_RESEARCH_SEARCHES,
        40,
        10,
      ),
      pagesMax: pick(
        env.COGETO_DAILY_RESEARCH_PAGES,
        env.COGETO_DEMO_DAILY_RESEARCH_PAGES,
        100,
        20,
      ),
      pagesPerRunMax: num(env.COGETO_RESEARCH_PAGES_PER_RUN, 5),
      // Named skills: the plan gate caps how many approved
      // queries one run may hold; the engine reads at most this many pages per
      // query. The daily research budgets above apply unchanged inside every
      // skill search and capture.
      skillQueriesMax: num(env.COGETO_SKILL_MAX_QUERIES, 6),
      skillPagesPerQuery: Math.min(
        num(env.COGETO_SKILL_PAGES_PER_QUERY, 3),
        num(env.COGETO_RESEARCH_PAGES_PER_RUN, 5),
      ),
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
      // Spreadsheets (V2.1 item 4.1): rows read per sheet and per file. The
      // read is truncated at these and the source says so.
      maxSheetRows: num(env.COGETO_PARSE_MAX_SHEET_ROWS, 5_000),
      maxFileRows: num(env.COGETO_PARSE_MAX_FILE_ROWS, 20_000),
      csvFallbackEncoding: env.COGETO_PARSE_CSV_FALLBACK_ENCODING?.trim() || 'windows-1250',
    },
  };
}
