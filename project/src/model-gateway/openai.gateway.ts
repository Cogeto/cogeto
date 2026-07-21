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
import { DEFAULT_OPENAI_BASE_URL } from './provider-config';

export interface OpenAiCompatibleGatewayOptions {
  apiKey: string;
  /** Any OpenAI-compatible endpoint (decision 0040 ruling 1) — the doorway a
   * local runtime walks through later. Default: the OpenAI API. */
  baseUrl?: string;
  /** Models per tier — no defaults: configuration must name them (ruling 3). */
  pipelineModel?: string;
  answerModel?: string;
  embedModel?: string;
  /** Sampling temperature for free-text completions (decision 0035); structured
   * extraction is ALWAYS temperature 0. */
  temperature?: number;
}

const EMBED_BATCH_SIZE = 128;

interface ChatResponse {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

interface EmbeddingsResponse {
  data?: { embedding?: number[] }[];
}

/**
 * OpenAI-compatible adapter (decision 0040): base URL + key + model names over
 * plain HTTPS — no SDK dependency, and deliberately compatible with any server
 * speaking the OpenAI chat/embeddings API shape. The only place in the system
 * that talks to such an endpoint (§A.10; `no_provider_leakage`).
 */
export class OpenAiCompatibleModelGateway extends ModelGateway {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly models: Partial<Record<ModelTier, string>>;
  private readonly embedModel?: string;
  private readonly temperature?: number;
  private reachabilityCache?: { at: number; value: GatewayReachability };

  constructor(options: OpenAiCompatibleGatewayOptions) {
    super();
    this.baseUrl = (options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/, '');
    this.headers = { authorization: `Bearer ${options.apiKey}` };
    this.models = { pipeline: options.pipelineModel, answer: options.answerModel };
    this.embedModel = options.embedModel;
    this.temperature = options.temperature;
  }

  private modelFor(tier: ModelTier): string {
    const model = this.models[tier];
    if (!model) {
      throw new ModelGatewayError(`no ${tier}-tier model configured for this provider`, false);
    }
    return model;
  }

  private chatBody(request: CompletionRequest, extra: Record<string, unknown> = {}): object {
    return {
      model: this.modelFor(request.tier ?? 'answer'),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      messages: [
        ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
        { role: 'user' as const, content: request.input },
      ],
      ...extra,
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await callWithRetry('openai', () =>
      postJson<ChatResponse>(
        `${this.baseUrl}/chat/completions`,
        this.headers,
        this.chatBody(request),
      ),
    );
    return {
      text: contentToText(response.choices?.[0]?.message?.content),
      ...usageOf(response),
    };
  }

  async *completeStream(request: CompletionRequest): AsyncIterable<string> {
    const response = await callWithRetry('openai', () =>
      postStream(
        `${this.baseUrl}/chat/completions`,
        this.headers,
        this.chatBody(request, { stream: true }),
      ),
    );
    for await (const data of sseData(response)) {
      if (data === '[DONE]') break;
      let event: { choices?: { delta?: { content?: unknown } }[] };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        continue;
      }
      const text = contentToText(event.choices?.[0]?.delta?.content);
      if (text) yield text;
    }
  }

  async extractStructured<T>(
    schema: ZodType<T, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T> {
    const model = this.modelFor(request.tier ?? 'pipeline');
    return structuredWithRepair(schema, async (extraInstruction) => {
      const response = await callWithRetry('openai', () =>
        postJson<ChatResponse>(`${this.baseUrl}/chat/completions`, this.headers, {
          model,
          // ALWAYS deterministic sampling (decision 0035): structured
          // extraction decides what Cogeto remembers — never a dice roll.
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system' as const, content: request.system },
            {
              role: 'user' as const,
              content: extraInstruction ? `${request.input}\n\n${extraInstruction}` : request.input,
            },
          ],
        }),
      );
      return contentToText(response.choices?.[0]?.message?.content);
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.embedModel) {
      throw new ModelGatewayError('no embeddings model configured for this provider', false);
    }
    if (texts.length === 0) return [];
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
      const response = await callWithRetry('openai', () =>
        postJson<EmbeddingsResponse>(`${this.baseUrl}/embeddings`, this.headers, {
          model: this.embedModel,
          input: batch,
        }),
      );
      const data = response.data ?? [];
      if (data.length !== batch.length) {
        throw new ModelGatewayError(
          `embedding batch returned ${data.length} vectors for ${batch.length} inputs`,
          true,
        );
      }
      for (const item of data) vectors.push(item.embedding ?? []);
    }
    return vectors;
  }

  embeddingModelId(): string {
    if (!this.embedModel) {
      throw new ModelGatewayError('no embeddings model configured for this provider', false);
    }
    return this.embedModel;
  }

  override async reachable(): Promise<GatewayReachability> {
    const now = Date.now();
    if (this.reachabilityCache && now - this.reachabilityCache.at < REACHABILITY_TTL_MS) {
      return this.reachabilityCache.value;
    }
    let value: GatewayReachability;
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers });
      value = response.ok
        ? { ok: true, detail: 'openai-compatible endpoint reachable' }
        : { ok: false, error: `openai-compatible endpoint unreachable: HTTP ${response.status}` };
    } catch (error) {
      value = {
        ok: false,
        error: `openai-compatible endpoint unreachable: ${error instanceof Error ? error.name : 'error'}`,
      };
    }
    this.reachabilityCache = { at: now, value };
    return value;
  }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((chunk) =>
        typeof chunk === 'object' && chunk !== null && 'text' in chunk
          ? String((chunk as { text: unknown }).text)
          : '',
      )
      .join('');
  }
  return '';
}

function usageOf(response: ChatResponse): { usage?: TokenUsage } {
  const prompt = response.usage?.prompt_tokens;
  const completion = response.usage?.completion_tokens;
  return typeof prompt === 'number' && typeof completion === 'number'
    ? { usage: { inputTokens: prompt, outputTokens: completion } }
    : {};
}
