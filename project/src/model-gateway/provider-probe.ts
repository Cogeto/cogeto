import { createModelGateway } from './factory';
import { DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_OPENAI_BASE_URL } from './provider-config';
import type { ModelProviderId, ResolvedModelProviders, TierBinding } from './provider-config';
import { probeImagePng, PROBE_IMAGE_MEDIA_TYPE, VISION_PROBE_MAX_TOKENS } from './vision-probe';
import { REASONING_PROBE_MAX_TOKENS } from './reasoning-probe';
import { ReasoningExhaustedBudgetError, VisionUnavailableError } from './errors';

/**
 * Provider discovery and validation (V2.4 item 7.1).
 *
 * Everything here talks to a provider endpoint, which is why it lives in the
 * seam and nowhere else (spec §12.1): the module that manages provider RECORDS
 * must not be the module that opens a socket to a provider. It asks the seam,
 * and the seam answers.
 *
 * Two questions, and the second is the one that matters:
 *
 * 1. **What models does this endpoint advertise?** A convenience, never an
 *    authority. A proxied deployment can legitimately serve models its
 *    `/models` route does not list — the reference deployment is exactly that:
 *    one Caddy vhost where `/v1/embeddings` goes to one llama.cpp process and
 *    everything else to another, so the embeddings model never appears in the
 *    list. Discovery therefore OFFERS; manual entry is always allowed.
 *
 * 2. **Does this model actually do the job this tier needs?** Answered by
 *    DOING it: a one-token completion, a one-string embedding, a 32-pixel
 *    image. Never by pattern matching a name — "embed" in a model name is a
 *    naming convention, not a capability, and the vision half of V2.1 item 4.1
 *    already established that the same weights are served with and without a
 *    multimodal projector and nothing in the name says which.
 */

/** Why a probe failed, kept apart because each sends an admin somewhere else. */
export type ProviderProbeFailure =
  | 'unreachable'
  | 'auth_failed'
  | 'model_not_found'
  | 'no_embeddings'
  | 'vision_unsupported'
  | 'unusable_response'
  | 'refused_by_policy'
  | 'timeout';

export interface ProviderProbeResult {
  ok: boolean;
  /** Present on success: what answered, in one sentence. */
  detail?: string;
  /** Present on failure: the operator-actionable message. Never a credential. */
  error?: string;
  reason?: ProviderProbeFailure;
  /** Embeddings probes: the returned vector's length — the model's REAL
   * dimension, which the managed rebuild records instead of a registry guess. */
  dimensions?: number;
  /** Embeddings probes: how long the one-string call took — the honest basis
   * for the rebuild plan's duration estimate. */
  latencyMs?: number;
}

/** A candidate endpoint: what a probe needs, before anything is saved. */
export interface ProbeTarget {
  provider: ModelProviderId;
  /** Adapter-ready base URL. Absent → the provider's hosted default. */
  baseUrl?: string;
  /** The decrypted key, or a placeholder for an endpoint with no auth. */
  apiKey: string;
  selfHosted: boolean;
}

/** The tier a model is being validated FOR — each needs a different call. */
export type ProbeTier = 'generation' | 'embeddings' | 'vision';

/** Generous, for the same reason the vision probe's deadline is: a cold model
 * warms slowly, and calling a working endpoint dead is the worse error. */
export const DEFAULT_PROVIDER_PROBE_TIMEOUT_MS = 30_000;

/** The models-endpoint deadline is short: it is a list, not an inference. */
export const DEFAULT_MODEL_LIST_TIMEOUT_MS = 10_000;

const hostedBaseUrl = (provider: ModelProviderId): string =>
  provider === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL;

const resolvedBaseUrl = (target: ProbeTarget): string =>
  (target.baseUrl ?? hostedBaseUrl(target.provider)).replace(/\/+$/, '');

/** Mistral speaks the OpenAI models route under its own host. */
const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';

/**
 * Ask the endpoint what it serves. Returns the names it advertises, sorted, or
 * a classified failure. A provider that answers with an empty list is a
 * SUCCESS with no models: the interface then says the endpoint advertises
 * nothing and offers manual entry, which is the honest reading of a proxy that
 * hides its routes.
 */
export async function listProviderModels(
  target: ProbeTarget,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ProviderProbeResult & { models?: string[] }> {
  const doFetch = options.fetchImpl ?? fetch;
  const base =
    target.provider === 'mistral' && !target.baseUrl ? MISTRAL_BASE_URL : resolvedBaseUrl(target);
  const url =
    target.provider === 'anthropic' ? `${base.replace(/\/v1$/, '')}/v1/models` : `${base}/models`;
  const headers: Record<string, string> =
    target.provider === 'anthropic'
      ? { 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${target.apiKey}` };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_MODEL_LIST_TIMEOUT_MS,
  );
  try {
    const response = await doFetch(url, { headers, signal: controller.signal });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason: 'auth_failed',
        error: `the endpoint answered but rejected the credential (HTTP ${response.status})`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: response.status === 404 ? 'model_not_found' : 'unreachable',
        error: `the endpoint answered HTTP ${response.status} for its model list`,
      };
    }
    const body = (await response.json()) as { data?: unknown; models?: unknown };
    const rows = Array.isArray(body.data)
      ? body.data
      : Array.isArray(body.models)
        ? body.models
        : [];
    const models = [
      ...new Set(
        rows
          .map((row) =>
            typeof row === 'string'
              ? row
              : typeof (row as { id?: unknown }).id === 'string'
                ? (row as { id: string }).id
                : typeof (row as { name?: unknown }).name === 'string'
                  ? (row as { name: string }).name
                  : undefined,
          )
          .filter((name): name is string => !!name),
      ),
    ].sort((a, b) => a.localeCompare(b));
    return { ok: true, models, detail: `the endpoint advertises ${models.length} model(s)` };
  } catch (error) {
    return {
      ok: false,
      reason: isAbort(error) ? 'timeout' : 'unreachable',
      error: describe(error, url),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate one model against the tier it is meant to serve, by using it.
 *
 * The probe goes through the ordinary factory, so it exercises the same adapter
 * the tier would: a model that passes here is a model that works there, and a
 * model that fails here never becomes an assignment.
 */
export async function probeProviderModel(
  target: ProbeTarget,
  request: { tier: ProbeTier; model: string; timeoutMs?: number },
): Promise<ProviderProbeResult> {
  const binding: TierBinding = {
    provider: target.provider,
    model: request.model,
    endpoint: {
      id: 'probe',
      label: 'probe',
      baseUrl: resolvedBaseUrl(target),
      apiKey: target.apiKey,
      selfHosted: target.selfHosted,
    },
  };
  const gateway = createModelGateway({ providers: probeConfiguration(binding, request.tier) });
  const timeoutMs = request.timeoutMs ?? DEFAULT_PROVIDER_PROBE_TIMEOUT_MS;
  const label = `${target.provider}/${request.model}`;
  try {
    if (request.tier === 'embeddings') {
      const startedAt = Date.now();
      const vectors = await withDeadline(gateway.embed(['probe']), timeoutMs, label);
      const latencyMs = Date.now() - startedAt;
      const dimensions = vectors[0]?.length ?? 0;
      if (dimensions === 0) {
        return {
          ok: false,
          reason: 'unusable_response',
          error: `${label} answered the embedding probe with an empty vector`,
        };
      }
      return {
        ok: true,
        detail: `${label} returned a ${dimensions}-dimension vector`,
        dimensions,
        latencyMs,
      };
    }
    if (request.tier === 'vision') {
      const result = await withDeadline(
        gateway.describeImage({
          input: 'Answer in one short sentence: what do you see in this image?',
          image: { bytes: probeImagePng(), mediaType: PROBE_IMAGE_MEDIA_TYPE },
          maxTokens: VISION_PROBE_MAX_TOKENS,
        }),
        timeoutMs,
        label,
      );
      if (result.text.trim().length === 0) {
        return {
          ok: false,
          reason: 'unusable_response',
          error: `${label} accepted the probe image and answered with nothing`,
        };
      }
      return { ok: true, detail: `${label} read the probe image` };
    }
    const result = await withDeadline(
      gateway.complete({
        tier: 'answer',
        input: 'Reply with the single word: ready.',
        // Sized for a REASONING model, not for the answer (the lesson the
        // vision probe learned twice): a cap that fits "ready." is consumed
        // entirely by deliberation. Exhausting it is treated as a PASS below,
        // so this is a ceiling on how long the probe runs, not a bar to clear.
        maxTokens: REASONING_PROBE_MAX_TOKENS,
      }),
      timeoutMs,
      label,
    );
    if (result.text.trim().length === 0) {
      return {
        ok: false,
        reason: 'unusable_response',
        error: `${label} answered the probe with no text`,
      };
    }
    return { ok: true, detail: `${label} answered the probe` };
  } catch (error) {
    // A reasoning model that spent the whole cap deliberating has PASSED: it
    // accepted the request, produced tokens and reasoned. The probe asks
    // whether this model serves this tier, not whether it is terse, and
    // refusing a working model at the moment an admin assigns it would be the
    // worst possible answer. Measured on the reference deployment, where the
    // reasoning model deliberates past 1024 tokens on "reply with one word".
    if (request.tier === 'generation' && error instanceof ReasoningExhaustedBudgetError) {
      return {
        ok: true,
        detail: `${label} answered, deliberating to the probe's token cap: it is a reasoning model`,
      };
    }
    return classify(error, label, request.tier);
  }
}

/**
 * The single-binding configuration the managed rebuild embeds through: the
 * TARGET provider and model on the embeddings tier, resolved like any other
 * binding so the ordinary factory can wrap it with the budget and audit
 * decorators (unlike a probe, a corpus rebuild is real metered spend and real
 * egress). The caller opens the key exactly as `targetFor` does; nothing here
 * stores it.
 */
export function embeddingRunConfiguration(
  target: ProbeTarget,
  model: string,
): ResolvedModelProviders {
  const binding: TierBinding = {
    provider: target.provider,
    model,
    endpoint: {
      id: 'embedding-rebuild',
      label: 'embedding-rebuild',
      baseUrl: resolvedBaseUrl(target),
      apiKey: target.apiKey,
      selfHosted: target.selfHosted,
    },
  };
  return { ...probeConfiguration(binding, 'embeddings'), id: 'embedding-rebuild' };
}

/**
 * The throwaway configuration a probe runs against: ONE binding, on the tier
 * being validated, and nothing else. Never redacted, never metered, never
 * audited — a probe is the instance testing itself, not anyone's content
 * leaving the box, and charging an admin's daily budget for a save button would
 * be its own bug.
 */
function probeConfiguration(binding: TierBinding, tier: ProbeTier): ResolvedModelProviders {
  const unused: TierBinding = { provider: binding.provider, model: binding.model };
  return {
    configured: true,
    id: 'probe',
    preset: null,
    tiers: {
      pipeline: unused,
      answer: tier === 'generation' ? binding : unused,
      embedding: tier === 'embeddings' ? binding : unused,
    },
    vision: tier === 'vision' ? binding : null,
    keys: { [binding.provider]: binding.endpoint!.apiKey },
    endpoints: {
      openaiBaseUrl: binding.endpoint!.baseUrl,
      anthropicBaseUrl: binding.endpoint!.baseUrl,
    },
    ollama: binding.provider === 'ollama' ? { baseUrl: binding.endpoint!.baseUrl } : null,
    timeoutsMs: { pipeline: 60_000, answer: 60_000, embedding: 60_000, vision: 120_000 },
    reasoningHeadroom: 4,
    openaiSelfHosted: binding.endpoint!.selfHosted,
    redacted: false,
    source: 'database',
    version: 0,
    answerOptions: [],
  };
}

/**
 * Turn a failure into the one of the named reasons an admin can act on.
 * Unreachable, rejected credential and unknown model are three different
 * problems with three different fixes, and "probe failed" sends someone to
 * check all three.
 */
function classify(error: unknown, label: string, tier: ProbeTier): ProviderProbeResult {
  if (error instanceof ReasoningExhaustedBudgetError) {
    // The endpoint worked and the model answered; it simply spent its whole
    // budget deliberating. Reporting that as unreachable would send an admin
    // to look at the network, which is the one place the problem is not.
    return {
      ok: false,
      reason: 'unusable_response',
      error:
        `${label} spent its entire output budget on reasoning and returned no answer text. ` +
        `The endpoint and the model are fine; raise COGETO_REASONING_HEADROOM if this model ` +
        `deliberates at length.`,
    };
  }
  if (error instanceof VisionUnavailableError) {
    return {
      ok: false,
      reason:
        error.reason === 'image_rejected'
          ? 'vision_unsupported'
          : error.reason === 'unreachable'
            ? 'unreachable'
            : error.reason === 'probe_timeout'
              ? 'timeout'
              : error.reason === 'refused_by_policy'
                ? 'refused_by_policy'
                : 'unusable_response',
      error: error.message,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (isAbort(error) || /timed out|deadline/i.test(message)) {
    return { ok: false, reason: 'timeout', error: `${label} did not answer in time` };
  }
  const status = /\(HTTP (\d{3})\)/.exec(message)?.[1];
  if (status === '401' || status === '403') {
    return {
      ok: false,
      reason: 'auth_failed',
      error: `${label} rejected the credential (HTTP ${status})`,
    };
  }
  if (status === '404' || /model.*(not found|does not exist|unknown)/i.test(message)) {
    return {
      ok: false,
      reason: tier === 'embeddings' ? 'no_embeddings' : 'model_not_found',
      error:
        tier === 'embeddings'
          ? `${label} has no embeddings route, or does not serve that model on it`
          : `${label} is not a model this endpoint serves`,
    };
  }
  if (status) {
    // Carry the upstream reason (issue #492): a bare status sends an admin
    // guessing, while the server's own sentence ("use max_completion_tokens",
    // an org-verification requirement, a deprecation notice) names the fix.
    // The message is already bounded by the HTTP layer's 200-char slice.
    const detail = message.split(`(HTTP ${status}): `)[1]?.trim();
    return {
      ok: false,
      reason: 'unusable_response',
      error: `${label} answered HTTP ${status}${detail ? `: ${detail}` : ''}`,
    };
  }
  return { ok: false, reason: 'unreachable', error: `${label} could not be reached` };
}

const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

/** A probe's own deadline, separate from the tier's minutes-long one. */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`${label} timed out`), { name: 'TimeoutError' })),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A network failure's description, with the URL but never a credential. */
function describe(error: unknown, url: string): string {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  if (isAbort(error)) return `${host} did not answer in time`;
  return `${host} could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`;
}
