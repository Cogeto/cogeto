import type { ZodType } from 'zod';
import { ModelGateway } from './model-gateway.service';
import type {
  CompletionRequest,
  CompletionResult,
  GatewayReachability,
  ModelTier,
  StructuredExtractionRequest,
  TokenUsage,
} from './model-gateway.service';
import { ModelGatewayError } from './errors';
import {
  callWithRetry,
  postJson,
  postStream,
  REACHABILITY_TTL_MS,
  sseData,
  structuredWithRepair,
} from './provider';
import { DEFAULT_ANTHROPIC_BASE_URL } from './provider-config';

export interface AnthropicGatewayOptions {
  apiKey: string;
  baseUrl?: string;
  /** Models per tier — no defaults: configuration must name them (ruling 3). */
  pipelineModel?: string;
  answerModel?: string;
  /** The Messages API REQUIRES max_tokens; used when the caller sets none. */
  maxTokensDefault?: number;
}

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;

/** Appended to the system prompt for structured calls — Anthropic has no JSON
 * mode on current models (and rejects assistant prefill), so the JSON contract
 * is instruction + fence-strip + the shared Zod repair loop (ruling 2). */
const JSON_ONLY_INSTRUCTION =
  'Respond with a single valid JSON object only — no prose before or after it, no Markdown code fence.';

interface MessagesResponse {
  content?: { type?: string; text?: unknown }[];
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

/**
 * Anthropic adapter (decision 0040): the Messages API over plain HTTPS — no
 * SDK dependency. No embeddings API exists, so this adapter is never eligible
 * for the embeddings tier (boot validation enforces it; embed() is a typed
 * failure if ever reached). Current Anthropic models reject sampling
 * parameters, so no temperature is sent — the documented deviation from
 * decision 0035 (see 0040 ruling 1).
 */
export class AnthropicModelGateway extends ModelGateway {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly models: Partial<Record<ModelTier, string>>;
  private readonly maxTokensDefault: number;
  private reachabilityCache?: { at: number; value: GatewayReachability };

  constructor(options: AnthropicGatewayOptions) {
    super();
    this.baseUrl = (options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/$/, '');
    this.headers = { 'x-api-key': options.apiKey, 'anthropic-version': ANTHROPIC_VERSION };
    this.models = { pipeline: options.pipelineModel, answer: options.answerModel };
    this.maxTokensDefault = options.maxTokensDefault ?? DEFAULT_MAX_TOKENS;
  }

  private modelFor(tier: ModelTier): string {
    const model = this.models[tier];
    if (!model) {
      throw new ModelGatewayError(`no ${tier}-tier model configured for this provider`, false);
    }
    return model;
  }

  private messagesBody(
    tier: ModelTier,
    system: string | undefined,
    input: string,
    maxTokens: number | undefined,
    extra: Record<string, unknown> = {},
  ): object {
    return {
      model: this.modelFor(tier),
      max_tokens: maxTokens ?? this.maxTokensDefault,
      ...(system ? { system } : {}),
      messages: [{ role: 'user' as const, content: input }],
      ...extra,
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await callWithRetry('anthropic', () =>
      postJson<MessagesResponse>(
        `${this.baseUrl}/v1/messages`,
        this.headers,
        this.messagesBody(
          request.tier ?? 'answer',
          request.system,
          request.input,
          request.maxTokens,
        ),
      ),
    );
    return { text: textOf(response), ...usageOf(response) };
  }

  async *completeStream(request: CompletionRequest): AsyncIterable<string> {
    const response = await callWithRetry('anthropic', () =>
      postStream(
        `${this.baseUrl}/v1/messages`,
        this.headers,
        this.messagesBody(
          request.tier ?? 'answer',
          request.system,
          request.input,
          request.maxTokens,
          {
            stream: true,
          },
        ),
      ),
    );
    for await (const data of sseData(response)) {
      let event: {
        type?: string;
        delta?: { type?: string; text?: unknown };
      };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        continue;
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text;
        if (typeof text === 'string' && text) yield text;
      }
    }
  }

  async extractStructured<T>(
    schema: ZodType<T, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T> {
    const tier = request.tier ?? 'pipeline';
    const system = `${request.system}\n\n${JSON_ONLY_INSTRUCTION}`;
    return structuredWithRepair(schema, async (extraInstruction) => {
      const response = await callWithRetry('anthropic', () =>
        postJson<MessagesResponse>(
          `${this.baseUrl}/v1/messages`,
          this.headers,
          this.messagesBody(
            tier,
            system,
            extraInstruction ? `${request.input}\n\n${extraInstruction}` : request.input,
            undefined,
          ),
        ),
      );
      return textOf(response);
    });
  }

  /** Anthropic exposes no embeddings API (ruling 3) — configuration validation
   * keeps the embeddings tier off this adapter; reaching this is a bug. */
  async embed(): Promise<number[][]> {
    throw new ModelGatewayError(
      'anthropic has no embeddings API — the embeddings tier must use another provider (decision 0040 ruling 3)',
      false,
    );
  }

  embeddingModelId(): string {
    throw new ModelGatewayError(
      'anthropic has no embeddings API — the embeddings tier must use another provider (decision 0040 ruling 3)',
      false,
    );
  }

  override async reachable(): Promise<GatewayReachability> {
    const now = Date.now();
    if (this.reachabilityCache && now - this.reachabilityCache.at < REACHABILITY_TTL_MS) {
      return this.reachabilityCache.value;
    }
    let value: GatewayReachability;
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, { headers: this.headers });
      value = response.ok
        ? { ok: true, detail: 'anthropic reachable' }
        : { ok: false, error: `anthropic unreachable: HTTP ${response.status}` };
    } catch (error) {
      value = {
        ok: false,
        error: `anthropic unreachable: ${error instanceof Error ? error.name : 'error'}`,
      };
    }
    this.reachabilityCache = { at: now, value };
    return value;
  }
}

function textOf(response: MessagesResponse): string {
  return (response.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function usageOf(response: MessagesResponse): { usage?: TokenUsage } {
  const input = response.usage?.input_tokens;
  const output = response.usage?.output_tokens;
  return typeof input === 'number' && typeof output === 'number'
    ? { usage: { inputTokens: input, outputTokens: output } }
    : {};
}
