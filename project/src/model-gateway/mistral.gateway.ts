import { Mistral } from '@mistralai/mistralai';
import type { ZodType } from 'zod';
import { ModelGateway } from './model-gateway.service';
import type {
  CompletionRequest,
  CompletionResult,
  GatewayReachability,
  StructuredExtractionRequest,
  TokenUsage,
} from './model-gateway.service';
import { ModelGatewayError, ModelGatewayNotConfiguredError } from './errors';
import type { ModelTier } from './model-gateway.service';
import { callWithRetry, REACHABILITY_TTL_MS, structuredWithRepair } from './provider';

export interface MistralGatewayOptions {
  apiKey: string;
  /** Model for the `pipeline` tier (extraction, verification). */
  pipelineModel?: string;
  /** Model for the `answer` tier (chat synthesis, eval grader). */
  answerModel?: string;
  embedModel?: string;
  /**
   * Sampling temperature for free-text completions (decision 0035). The eval
   * harness pins 0 so runs are comparable; production chat leaves it unset
   * (provider default). Structured extraction is ALWAYS temperature 0
   * regardless — what Cogeto remembers must not depend on a dice roll.
   */
  temperature?: number;
}

const DEFAULT_PIPELINE_MODEL = 'mistral-small-latest';
const DEFAULT_ANSWER_MODEL = 'mistral-medium-latest';
const DEFAULT_EMBED_MODEL = 'mistral-embed';
const EMBED_BATCH_SIZE = 128;

/**
 * The only place in the system that touches the Mistral client (§A.10) —
 * enforced by a dependency-cruiser rule. Maps model tiers (decision 0007
 * ruling 3) to concrete Mistral models; callers never name a model string.
 * Retry/error classification and the structured repair loop are the shared
 * provider contract (decision 0040 rulings 1–2).
 */
export class MistralModelGateway extends ModelGateway {
  private readonly client: Mistral;
  private readonly models: Record<ModelTier, string>;
  private readonly embedModel: string;
  private readonly temperature?: number;
  private reachabilityCache?: { at: number; value: GatewayReachability };

  constructor(options: MistralGatewayOptions) {
    super();
    this.client = new Mistral({ apiKey: options.apiKey });
    this.models = {
      pipeline: options.pipelineModel ?? DEFAULT_PIPELINE_MODEL,
      answer: options.answerModel ?? DEFAULT_ANSWER_MODEL,
    };
    this.embedModel = options.embedModel ?? DEFAULT_EMBED_MODEL;
    this.temperature = options.temperature;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await callWithRetry('mistral', () =>
      this.client.chat.complete({
        model: this.models[request.tier ?? 'answer'],
        maxTokens: request.maxTokens,
        ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
        messages: [
          ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
          { role: 'user' as const, content: request.input },
        ],
      }),
    );
    return { text: contentToText(response.choices?.[0]?.message?.content), ...usageOf(response) };
  }

  async *completeStream(request: CompletionRequest): AsyncIterable<string> {
    const stream = await callWithRetry('mistral', () =>
      this.client.chat.stream({
        model: this.models[request.tier ?? 'answer'],
        maxTokens: request.maxTokens,
        ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
        messages: [
          ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
          { role: 'user' as const, content: request.input },
        ],
      }),
    );
    for await (const event of stream) {
      const text = contentToText(event.data.choices?.[0]?.delta?.content);
      if (text) yield text;
    }
  }

  async extractStructured<T>(
    schema: ZodType<T, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T> {
    const model = this.models[request.tier ?? 'pipeline'];
    return structuredWithRepair(schema, async (extraInstruction) => {
      const response = await callWithRetry('mistral', () =>
        this.client.chat.complete({
          model,
          // ALWAYS deterministic sampling (decision 0035): structured
          // extraction decides what Cogeto remembers — never a dice roll.
          temperature: 0,
          responseFormat: { type: 'json_object' },
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
    if (texts.length === 0) return [];
    const vectors: number[][] = [];
    // Batched: Mistral's embeddings endpoint caps inputs per request; chunking
    // here keeps callers oblivious. Errors carry the retryable flag via the
    // shared retry helper.
    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
      const response = await callWithRetry('mistral', () =>
        this.client.embeddings.create({ model: this.embedModel, inputs: batch }),
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
    return this.embedModel;
  }

  /**
   * Cached reachability probe (QS-35): one cheap `models.list` at most every
   * {@link REACHABILITY_TTL_MS}, so repeated health polls never hammer the
   * provider. A failure surfaces as ok:false with the class-only message.
   */
  override async reachable(): Promise<GatewayReachability> {
    const now = Date.now();
    if (this.reachabilityCache && now - this.reachabilityCache.at < REACHABILITY_TTL_MS) {
      return this.reachabilityCache.value;
    }
    let value: GatewayReachability;
    try {
      await this.client.models.list();
      value = { ok: true, detail: 'mistral reachable' };
    } catch (error) {
      value = {
        ok: false,
        error: `mistral unreachable: ${error instanceof Error ? error.name : 'error'}`,
      };
    }
    this.reachabilityCache = { at: now, value };
    return value;
  }
}

/** Boots without a key (app/worker do not need the model to start); fails on use. */
export class UnconfiguredModelGateway extends ModelGateway {
  complete(): Promise<CompletionResult> {
    throw new ModelGatewayNotConfiguredError();
  }
  // eslint-disable-next-line require-yield -- fails on first pull, like the rest
  async *completeStream(): AsyncIterable<string> {
    throw new ModelGatewayNotConfiguredError();
  }
  extractStructured<T>(): Promise<T> {
    throw new ModelGatewayNotConfiguredError();
  }
  embed(): Promise<number[][]> {
    throw new ModelGatewayNotConfiguredError();
  }
  embeddingModelId(): string {
    throw new ModelGatewayNotConfiguredError();
  }
  // Not an error state for health (QS-35): an instance may deliberately run
  // without a model key; report "not configured" but stay ok so it doesn't
  // degrade the whole instance.
  override async reachable(): Promise<GatewayReachability> {
    return { ok: true, detail: 'model gateway not configured — model features disabled' };
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

function usageOf(response: { usage?: { promptTokens?: number; completionTokens?: number } }): {
  usage?: TokenUsage;
} {
  const prompt = response.usage?.promptTokens;
  const completion = response.usage?.completionTokens;
  return typeof prompt === 'number' && typeof completion === 'number'
    ? { usage: { inputTokens: prompt, outputTokens: completion } }
    : {};
}
