import { ReasoningExhaustedBudgetError } from './errors';
import type { ModelGateway, ModelTier } from './model-gateway.service';
import type { ResolvedModelProviders, TierBinding } from './provider-config';

/**
 * The reasoning probe (Part B of reasoning support): does THIS configuration
 * return its thinking in a separate reasoning field?
 *
 * The answer cannot be read off a model name, a provider name, or a
 * configuration flag, for the same reason vision cannot: the identical weights
 * are served both ways. A llama.cpp server decides at serve time whether
 * thinking arrives as `reasoning_content` beside an empty-until-done `content`,
 * and nothing in the model's name says which way it was started. The
 * consequence of guessing wrong is concrete: any maxTokens cap can be entirely
 * consumed by reasoning, returning an empty string that looks like a model
 * failure.
 *
 * So the probe sends a REAL trivial prompt through the real gateway,
 * decorators and all, once per distinct generation binding, and reports
 * whether a reasoning field came back. As a side effect the adapter that
 * served the call learns the same fact, which is what arms the maxTokens
 * headroom multiplier for every later call on that model — including the
 * vision probe's, which is why this probe must run BEFORE the vision probe.
 */

export interface ReasoningProbeResult {
  /** True when at least one generation binding returned a reasoning field. */
  reasoning: boolean;
  /** False when there was nothing to probe (unconfigured gateway). */
  probed: boolean;
  /** What was found, in operator terms: the bindings and their answers. */
  detail?: string;
  /** Present when a binding could not be probed; reasoning stays false. */
  error?: string;
}

/**
 * Trivial on purpose: the probe asks whether a reasoning FIELD comes back,
 * not whether the model reasons well. Measured on the reference reasoning
 * model, even this instruction produces a couple hundred reasoning tokens
 * before the two-character answer, which is exactly the signal.
 */
const PROBE_INSTRUCTION = 'Say OK.';

/**
 * Generous on purpose: enough for a chatty reasoner to finish deliberating
 * about saying OK. Undersizing it is harmless for detection — a cap consumed
 * entirely by reasoning still returns the reasoning field (or the named
 * exhaustion error, which proves reasoning just as well) — but a completed
 * answer keeps the probe's log line quiet.
 */
export const REASONING_PROBE_MAX_TOKENS = 1024;

/** Same rationale as the vision probe's deadline: a remote or cold model
 * takes far longer to warm than to run, and declaring a working runtime
 * non-reasoning re-breaks every capped call on it. */
export const DEFAULT_REASONING_PROBE_TIMEOUT_MS = 30_000;

/** Probes each DISTINCT generation binding (pipeline, answer) once. */
export async function probeReasoning(
  gateway: ModelGateway,
  providers: ResolvedModelProviders | undefined,
  options: { timeoutMs?: number } = {},
): Promise<ReasoningProbeResult> {
  if (!providers?.configured) {
    return {
      reasoning: false,
      probed: false,
      detail: 'the model gateway is not configured, so there is no binding to probe',
    };
  }

  // One probe per distinct (provider, model): a configuration with both
  // generation tiers on the same binding answers with one call.
  const bindings = new Map<string, { tier: ModelTier; binding: TierBinding }>();
  for (const tier of ['pipeline', 'answer'] as const) {
    const binding = providers.tiers[tier];
    const key = `${binding.provider}/${binding.model}`;
    if (!bindings.has(key)) bindings.set(key, { tier, binding });
  }

  const reasoningBindings: string[] = [];
  const plainBindings: string[] = [];
  const failures: string[] = [];
  for (const [key, { tier }] of bindings) {
    try {
      const result = await withTimeout(
        gateway.complete({
          input: PROBE_INSTRUCTION,
          maxTokens: REASONING_PROBE_MAX_TOKENS,
          tier,
        }),
        options.timeoutMs,
        key,
      );
      (result.reasoned ? reasoningBindings : plainBindings).push(key);
    } catch (error) {
      // The exhaustion error IS a reasoning field observation: only a model
      // that returned one can spend its whole budget on it.
      if (error instanceof ReasoningExhaustedBudgetError) {
        reasoningBindings.push(key);
        continue;
      }
      failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (reasoningBindings.length > 0) {
    return {
      reasoning: true,
      probed: true,
      detail:
        `a separate reasoning field came back from ${reasoningBindings.join(', ')}; ` +
        `maxTokens headroom x${providers.reasoningHeadroom} is active on those bindings`,
    };
  }
  if (failures.length > 0) {
    return {
      reasoning: false,
      probed: true,
      detail: 'reasoning could not be determined; treated as off until a probe succeeds',
      error: `the reasoning probe failed: ${failures.join('; ')}`,
    };
  }
  return {
    reasoning: false,
    probed: true,
    detail: `no generation binding returned a reasoning field (${plainBindings.join(', ')})`,
  };
}

/** The probe's own deadline; a timeout reports the binding as unprobed. */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number | undefined,
  binding: string,
): Promise<T> {
  if (timeoutMs === undefined) return work;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `no answer within ${timeoutMs} ms (a cold model warms slowly; raise ` +
              `COGETO_REASONING_PROBE_TIMEOUT_MS if ${binding} is otherwise healthy)`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
