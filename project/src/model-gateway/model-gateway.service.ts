import type { ZodType } from 'zod';
import { VisionUnavailableError } from './errors';

/**
 * Provider-neutral model seam (scope §5.1, spec §12.1): complete / extractStructured /
 * embed — never a wrapper around one vendor's types. Swapping backends may not
 * touch callers.
 */

/**
 * Per-task model tier. Task sites request a TIER, never
 * a vendor model string — the gateway maps tiers to concrete models from config
 * - `pipeline` — extraction, verification, future consolidation (cheaper model).
 * - `answer`   — chat synthesis and the eval grader (stronger general model).
 * Each method has a sensible default tier, so most callers name none.
 */
export type ModelTier = 'pipeline' | 'answer';

export interface CompletionRequest {
  system?: string;
  input: string;
  maxTokens?: number;
  /** Defaults to `answer` — completion is the user-facing synthesis path. */
  tier?: ModelTier;
  /**
   * Requested thinking MODE (reasoning support): `off` asks a reasoning model
   * to answer directly, `on` to deliberate. Provider-neutral intent: the
   * OpenAI-compatible adapter maps it to the server's template flag and the
   * paired sampler profile on self-hosted endpoints; every other adapter and
   * a hosted endpoint ignore it. Unset sends byte-identical requests, and a
   * server that ignores the flag still works — the probe and headroom stay.
   */
  thinking?: 'on' | 'off';
  /**
   * The answer model this user picked for themselves (V2.4 item 7.1), as the
   * OPAQUE option id an admin enabled — never a vendor model string, so the
   * call site still names a tier and the seam still owns the mapping. Ignored
   * on any tier but `answer`, and ignored when the option is no longer enabled:
   * an admin retiring a choice must not break the next question a user asks.
   */
  answerOption?: string;
  /**
   * Abort the call in flight (issue #532). Set only by the chat stream, whose
   * Stop button must end GENERATION and not merely stop reading: without it
   * the provider runs to completion and bills for an answer nobody sees.
   *
   * Combined with, never replacing, the seam's unsignalled ceiling: passing a
   * caller signal must not silently remove the wedged-socket guard.
   */
  signal?: AbortSignal;
}

/**
 * Provider-reported token usage, normalized: each
 * adapter maps its upstream's field names into this one shape so the budget
 * decorator can charge real counts where the provider reports them.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResult {
  text: string;
  /** Present when the provider reported usage for this call (ruling 4). */
  usage?: TokenUsage;
  /**
   * True when the provider returned a separate reasoning field beside the
   * answer (Part B of reasoning support). A fact about the RESPONSE SHAPE for
   * the reasoning capability probe, never the reasoning text: thinking is a
   * channel, not content, and the text itself is discarded in the adapter.
   * Absent (not false) for providers and models that do not reason, so a
   * non-reasoning result is byte-identical to what it always was.
   */
  reasoned?: boolean;
}

/**
 * One image for the vision tier (V2.1 item 4.1): raw bytes plus the media type
 * the adapter needs to build a data URL or a provider image block. Bytes, never
 * a path or a URL — the seam does no I/O and the model never fetches anything.
 */
export interface VisionImage {
  bytes: Buffer;
  /** `image/png`, `image/jpeg`, … */
  mediaType: string;
}

export interface VisionRequest {
  /** The versioned prompt artifact's content (spec §12.3). */
  system?: string;
  input: string;
  image: VisionImage;
  maxTokens?: number;
}

export interface StructuredExtractionRequest {
  /** The system prompt — a versioned artifact loaded via the prompt loader (spec §12.3). */
  system: string;
  input: string;
  /** Defaults to `pipeline` — structured extraction is slow-path ingestion work. */
  tier?: ModelTier;
}

/**
 * One streamed delta (Part A of reasoning support): the seam yields
 * channel-tagged text instead of bare strings, because a reasoning model
 * produces two interleaved streams and only one of them is the answer.
 *
 * `thinking` is a CHANNEL, not content: it is displayed live and stored beside
 * the chat message it explains, and it is never captured, cited, verified, or
 * evaluated. A non-reasoning model only ever yields `text` deltas — the same
 * bytes it always yielded, one field deeper.
 */
export interface StreamDelta {
  channel: 'thinking' | 'text';
  text: string;
}

export abstract class ModelGateway {
  abstract complete(request: CompletionRequest): Promise<CompletionResult>;
  /**
   * Streaming completion for the fast path (chat, spec §3.4): yields
   * channel-tagged deltas in order (Part A). Same seam rule as everything
   * else — no provider types leak out.
   */
  abstract completeStream(request: CompletionRequest): AsyncIterable<StreamDelta>;
  /**
   * Requests JSON output, parses it, and validates it against the Zod schema.
   * The input type is free so schemas may use.default for omitted fields.
   */
  abstract extractStructured<T>(
    schema: ZodType<T, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T>;
  /** Batched; one vector per input text, in order. */
  abstract embed(texts: string[]): Promise<number[][]>;
  /**
   * The identifier of the model embed uses — recorded per memory
   * (embedding_model, migration 0004) so reindex knows when re-embedding
   * is required.
   */
  abstract embeddingModelId(): string;

  /**
   * The identity per-embedding-model CALIBRATION is keyed by (the ambiguity
   * and reconciliation threshold tables). For every ordinary binding this is
   * `embeddingModelId()`. A served-name binding (the managed provider,
   * migration 0064) answers the upstream identity behind the name instead,
   * because a threshold is a fact about vector geometry and the served name
   * is branding over it; keying by the brand would refuse or miscut a model
   * whose geometry IS measured. The value is a LOOKUP KEY ONLY: it must
   * never reach a user, a record, a report or a log line, which is why the
   * threshold lookups take the display name as a separate argument. Wrappers
   * forward it like `embeddingModelId`.
   */
  embeddingGeometryId(): string {
    return this.embeddingModelId();
  }

  /**
   * Reads an image (V2.1 item 4.1). Separate from `complete` because it is a
   * separate CAPABILITY, not a parameter: the same weights are served with and
   * without a multimodal projector, so a gateway that cannot take images must
   * say so rather than fail somewhere inside a text call.
   *
   * The base implementation refuses, which is the correct answer for every
   * adapter that has no vision binding and for the unconfigured gateway. An
   * adapter that supports images overrides it; the decorators forward it.
   */
  async describeImage(_request: VisionRequest): Promise<CompletionResult> {
    throw new VisionUnavailableError(
      'not_configured',
      'no vision tier is configured for this instance',
    );
  }

  /**
   * Cheap, cached reachability probe for the health surface — never on a
   * request hot path. The base default assumes reachable (in-memory/test
   * gateways are always up); the Mistral impl does a real cached probe,
   * Unconfigured reports "not configured" (still ok — model features are simply
   * off), and the decorators delegate to the wrapped gateway.
   */
  async reachable(): Promise<GatewayReachability> {
    return { ok: true, detail: 'gateway reachable' };
  }
}

/** Result of {@link ModelGateway.reachable} — the health controller adds latency. */
export interface GatewayReachability {
  ok: boolean;
  detail?: string;
  error?: string;
}
