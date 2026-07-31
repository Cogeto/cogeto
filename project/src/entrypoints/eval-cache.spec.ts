import { describe, expect, it } from 'vitest';
import { evalCacheKey, evalCacheModeFromEnv, normalizeForKey } from './eval-cache';

/**
 * The cache-key contract (V2.0 item 3.4). A cache that fails to invalidate
 * reports green over stale responses, which is worse than having no gate at
 * all, so every input that can change a model's answer is asserted to change
 * the key.
 */
describe('eval cache key', () => {
  const base = {
    op: 'structured' as const,
    model: 'mistral-small-latest',
    tier: 'pipeline',
    system: 'EXTRACTION PROMPT v0004\nRules…',
    input: 'BEGIN UNTRUSTED\nAna owes Marko the proposal.\nEND UNTRUSTED',
  };

  it('is stable for identical inputs', () => {
    expect(evalCacheKey(base)).toBe(evalCacheKey({ ...base }));
  });

  it('MISSES when the prompt changes, by construction', () => {
    // The system string IS the rendered prompt artifact, so a version bump and
    // an uncommitted local edit both miss. Nothing has to remember to bump.
    const edited = { ...base, system: `${base.system} Extract aggressively.` };
    expect(evalCacheKey(edited)).not.toBe(evalCacheKey(base));
  });

  it('misses when the model, the tier, or the operation changes', () => {
    expect(evalCacheKey({ ...base, model: 'mistral-medium-latest' })).not.toBe(evalCacheKey(base));
    expect(evalCacheKey({ ...base, tier: 'answer' })).not.toBe(evalCacheKey(base));
    expect(evalCacheKey({ ...base, op: 'complete' })).not.toBe(evalCacheKey(base));
  });

  it('misses when one character of the rendered input changes, fence included', () => {
    expect(evalCacheKey({ ...base, input: base.input.replace('END', 'end') })).not.toBe(
      evalCacheKey(base),
    );
  });

  it('HITS across run-scoped UUIDs, the one normalisation', () => {
    // A fresh Testcontainers database mints new ids every run; no model
    // response can depend on them.
    const runA = { ...base, input: `memory 3f2504e0-4f89-41d3-9a0c-0305e82c3301 seen` };
    const runB = { ...base, input: `memory 9c858901-8a57-4791-81fe-4c455b099bc9 seen` };
    expect(evalCacheKey(runA)).toBe(evalCacheKey(runB));
    // …and still misses when anything around them differs.
    expect(evalCacheKey({ ...runA, input: `${runA.input}!` })).not.toBe(evalCacheKey(runB));
  });

  it('HITS across the fence boundary id, which is random per model call', () => {
    // audit 2.0 SEC-4 mints 18 fresh hex characters on every call. Without
    // this, every fenced input misses forever and the gate is useless.
    const fenced = (b: string) =>
      `SOURCE CONTENT:\n-----BEGIN UNTRUSTED DATA ${b}-----\nAna owes Marko.\n-----END UNTRUSTED DATA ${b}-----`;
    expect(evalCacheKey({ ...base, input: fenced('a1b2c3d4e5f60718a9') })).toBe(
      evalCacheKey({ ...base, input: fenced('0f1e2d3c4b5a697887') }),
    );
  });

  it('still misses when a fence is REMOVED, not just re-numbered', () => {
    // The id is normalised inside its marker line only, so the fence's
    // presence and position keep hashing.
    const b = 'a1b2c3d4e5f60718a9';
    const withFence = `-----BEGIN UNTRUSTED DATA ${b}-----\nAna owes Marko.\n-----END UNTRUSTED DATA ${b}-----`;
    expect(evalCacheKey({ ...base, input: withFence })).not.toBe(
      evalCacheKey({ ...base, input: 'Ana owes Marko.' }),
    );
  });

  it('HITS across the now-block wall clock, which moves every minute', () => {
    const block = (stamp: string) =>
      `NOW: ${stamp} (Europe/Zagreb)\nLANGUAGE: answer in the user's language\n\nQUESTION:\nWho is Ana?`;
    expect(evalCacheKey({ ...base, input: block('Friday, 2026-07-31, 20:14') })).toBe(
      evalCacheKey({ ...base, input: block('Monday, 2026-08-03, 09:02') }),
    );
  });

  it('still misses when the timezone or another now-block line changes', () => {
    // Only the instant is ambient. Everything else in the block is real input.
    const zagreb = 'NOW: Friday, 2026-07-31, 20:14 (Europe/Zagreb)\nLANGUAGE: hr';
    expect(evalCacheKey({ ...base, input: zagreb })).not.toBe(
      evalCacheKey({
        ...base,
        input: 'NOW: Friday, 2026-07-31, 20:14 (Europe/Berlin)\nLANGUAGE: hr',
      }),
    );
    expect(evalCacheKey({ ...base, input: zagreb })).not.toBe(
      evalCacheKey({
        ...base,
        input: 'NOW: Friday, 2026-07-31, 20:14 (Europe/Zagreb)\nLANGUAGE: en',
      }),
    );
  });

  it('normalizes only run-scoped identifiers', () => {
    expect(normalizeForKey('id 3f2504e0-4f89-41d3-9a0c-0305e82c3301 at 2026-07-31')).toBe(
      'id <uuid> at 2026-07-31',
    );
    // A bare hex run in ordinary content is NOT a fence id and is left alone.
    expect(normalizeForKey('hash a1b2c3d4e5f60718a9 in the body')).toBe(
      'hash a1b2c3d4e5f60718a9 in the body',
    );
  });
});

describe('eval cache mode', () => {
  it('defaults to off and accepts record/replay', () => {
    expect(evalCacheModeFromEnv({})).toBe('off');
    expect(evalCacheModeFromEnv({ COGETO_EVAL_CACHE: '' })).toBe('off');
    expect(evalCacheModeFromEnv({ COGETO_EVAL_CACHE: 'record' })).toBe('record');
    expect(evalCacheModeFromEnv({ COGETO_EVAL_CACHE: 'REPLAY' })).toBe('replay');
  });

  it('refuses an unrecognised value rather than silently running live', () => {
    expect(() => evalCacheModeFromEnv({ COGETO_EVAL_CACHE: 'yes' })).toThrow(
      /off \| record \| replay/,
    );
  });
});
