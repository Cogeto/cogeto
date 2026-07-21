import type { ZodType } from 'zod';

/**
 * Provider-neutral model seam (scope §5.1, §A.10): complete / extractStructured /
 * embed — never a wrapper around one vendor's types. Swapping backends may not
 * touch callers.
 */

/**
 * Per-task model tier (decision 0007 ruling 3). Task sites request a TIER, never
 * a vendor model string — the gateway maps tiers to concrete models from config:
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
}

/**
 * Provider-reported token usage, normalized (decision 0040 ruling 4): each
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
}

export interface StructuredExtractionRequest {
  /** The system prompt — a versioned artifact loaded via the prompt loader (§B.7). */
  system: string;
  input: string;
  /** Defaults to `pipeline` — structured extraction is slow-path ingestion work. */
  tier?: ModelTier;
}

export abstract class ModelGateway {
  abstract complete(request: CompletionRequest): Promise<CompletionResult>;
  /**
   * Streaming completion for the fast path (chat, §A.5): yields text deltas in
   * order. Same seam rule as everything else — no provider types leak out.
   */
  abstract completeStream(request: CompletionRequest): AsyncIterable<string>;
  /**
   * Requests JSON output, parses it, and validates it against the Zod schema.
   * The input type is free so schemas may use .default() for omitted fields.
   */
  abstract extractStructured<T>(
    schema: ZodType<T, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T>;
  /** Batched; one vector per input text, in order. */
  abstract embed(texts: string[]): Promise<number[][]>;
  /**
   * The identifier of the model embed() uses — recorded per memory
   * (embedding_model, migration 0004) so reindex knows when re-embedding
   * is required.
   */
  abstract embeddingModelId(): string;

  /**
   * Cheap, cached reachability probe for the health surface (QS-35) — never on a
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
