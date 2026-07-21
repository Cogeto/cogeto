import { Mistral } from '@mistralai/mistralai';
import { ZodError } from 'zod';
import type { ZodType } from 'zod';
import { ModelGateway } from './model-gateway.service';
import type {
  CompletionRequest,
  CompletionResult,
  GatewayReachability,
  StructuredExtractionRequest,
} from './model-gateway.service';
import { ModelGatewayError, ModelGatewayNotConfiguredError } from './errors';
import type { ModelTier } from './model-gateway.service';

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
    const response = await this.call(() =>
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
    return { text: contentToText(response.choices?.[0]?.message?.content) };
  }

  async *completeStream(request: CompletionRequest): AsyncIterable<string> {
    const stream = await this.call(() =>
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
    const attempt = async (extraInstruction?: string): Promise<T> => {
      const response = await this.call(() =>
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
      const text = contentToText(response.choices?.[0]?.message?.content);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ModelGatewayError('model returned non-JSON output', false);
      }
      return schema.parse(parsed);
    };

    try {
      return await attempt();
    } catch (error) {
      // One corrective retry on schema violations only; provider errors already
      // carry their retryable classification from call().
      if (error instanceof ZodError) {
        const issues = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        try {
          return await attempt(
            `The previous JSON answer failed validation (${issues}). Answer again with JSON matching the required shape exactly.`,
          );
        } catch (secondError) {
          if (secondError instanceof ZodError) {
            throw new ModelGatewayError(
              `structured output failed schema validation twice: ${issues}`,
              false,
              secondError,
            );
          }
          throw secondError;
        }
      }
      throw error;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors: number[][] = [];
    // Batched: Mistral's embeddings endpoint caps inputs per request; chunking
    // here keeps callers oblivious. Errors carry the retryable flag via call().
    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
      const response = await this.call(() =>
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

  /**
   * Maps provider/network failures to typed errors with a retryable flag, and
   * retries retryable ones (429 rate-limits, 5xx, network) with exponential
   * backoff before giving up. Transient rate-limits during a burst (evals,
   * batch ingestion) no longer fail the call on the first 429; a genuine error
   * still surfaces as a ModelGatewayError after the bounded attempts.
   */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const status = extractStatus(error);
        const retryable = status === undefined || status === 429 || status >= 500;
        if (retryable && attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_MS * 2 ** attempt);
          continue;
        }
        throw new ModelGatewayError(
          `mistral call failed${status ? ` (HTTP ${status})` : ''}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retryable,
          error,
        );
      }
    }
  }
}

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 800;
/** Reachability probe cache window (QS-35) — health polls reuse it. */
const REACHABILITY_TTL_MS = 30_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

function extractStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    const candidate =
      (error as { statusCode?: unknown }).statusCode ?? (error as { status?: unknown }).status;
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}
