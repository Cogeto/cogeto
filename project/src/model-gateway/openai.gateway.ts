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
  /** Any OpenAI-compatible endpoint (decision 0040 ruling 1) — the doorway the
   * local runtime walks through (decision 0041). Default: the OpenAI API. */
  baseUrl?: string;
  /** Models per tier — no defaults: configuration must name them (ruling 3). */
  pipelineModel?: string;
  answerModel?: string;
  embedModel?: string;
  /** Sampling temperature for free-text completions (decision 0035); structured
   * extraction is ALWAYS temperature 0. */
  temperature?: number;
  /** Provider name used in error messages and retry logs — 'ollama' for the
   * local flavor (decision 0041 ruling 1); defaults to 'openai'. */
  providerLabel?: string;
  /**
   * Per-tier request timeouts (decision 0041 ruling 2) — local inference on
   * consumer hardware needs seconds-to-minutes, independently per tier. Absent
   * (every hosted configuration): no explicit timeout, byte-identical to
   * Priority 3 behavior. A timed-out call is FATAL, not retryable — retrying a
   * saturated local runtime only piles on.
   */
  tierTimeoutsMs?: { pipeline?: number; answer?: number; embedding?: number };
  /**
   * Marks this instance as a LOCAL Ollama runtime (decision 0041): `rootUrl`
   * is the runtime root; `reachable()` probes `<root>/api/tags`, and an HTTP
   * 404 model-not-found becomes a fatal, actionable error naming the missing
   * model and the `ollama pull` command.
   */
  localRuntime?: { rootUrl: string };
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
  private readonly label: string;
  private readonly tierTimeoutsMs?: OpenAiCompatibleGatewayOptions['tierTimeoutsMs'];
  private readonly localRuntime?: { rootUrl: string };
  private reachabilityCache?: { at: number; value: GatewayReachability };

  constructor(options: OpenAiCompatibleGatewayOptions) {
    super();
    this.baseUrl = (options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/, '');
    this.headers = { authorization: `Bearer ${options.apiKey}` };
    this.models = { pipeline: options.pipelineModel, answer: options.answerModel };
    this.embedModel = options.embedModel;
    this.temperature = options.temperature;
    this.label = options.providerLabel ?? 'openai';
    this.tierTimeoutsMs = options.tierTimeoutsMs;
    this.localRuntime = options.localRuntime;
  }

  private modelFor(tier: ModelTier): string {
    const model = this.models[tier];
    if (!model) {
      throw new ModelGatewayError(`no ${tier}-tier model configured for this provider`, false);
    }
    return model;
  }

  /**
   * One retried call with the local-inference realities applied (decision 0041
   * ruling 2): the tier's timeout (fresh abort signal per attempt; a timeout is
   * fatal with the variable to raise), and — on a local runtime — HTTP 404
   * model-not-found rethrown fatal with the exact `ollama pull` fix.
   */
  private async call<T>(
    tier: 'pipeline' | 'answer' | 'embedding',
    model: string,
    fn: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = this.tierTimeoutsMs?.[tier];
    const suffix = tier === 'embedding' ? 'EMBEDDINGS' : tier.toUpperCase();
    try {
      return await callWithRetry(this.label, async () => {
        try {
          return await fn(timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined);
        } catch (error) {
          if (isTimeoutError(error)) {
            throw new ModelGatewayError(
              `${this.label} ${tier} call timed out after ${timeoutMs} ms — raise ` +
                `COGETO_OLLAMA_TIMEOUT_${suffix}_MS or use a smaller/faster model`,
              false,
              error,
            );
          }
          throw error;
        }
      });
    } catch (error) {
      if (
        this.localRuntime &&
        error instanceof ModelGatewayError &&
        (error.cause as { statusCode?: number } | undefined)?.statusCode === 404 &&
        /not found/i.test(error.message)
      ) {
        throw new ModelGatewayError(
          `model "${model}" is not available on the Ollama runtime at ` +
            `${this.localRuntime.rootUrl} — run \`ollama pull ${model}\` on the Ollama host`,
          false,
          error,
        );
      }
      throw error;
    }
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
    const tier = request.tier ?? 'answer';
    const response = await this.call(tier, this.modelFor(tier), (signal) =>
      postJson<ChatResponse>(
        `${this.baseUrl}/chat/completions`,
        this.headers,
        this.chatBody(request),
        signal,
      ),
    );
    return {
      text: contentToText(response.choices?.[0]?.message?.content),
      ...usageOf(response),
    };
  }

  async *completeStream(request: CompletionRequest): AsyncIterable<string> {
    const tier = request.tier ?? 'answer';
    const response = await this.call(tier, this.modelFor(tier), (signal) =>
      postStream(
        `${this.baseUrl}/chat/completions`,
        this.headers,
        this.chatBody(request, { stream: true }),
        signal,
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
    const tier = request.tier ?? 'pipeline';
    const model = this.modelFor(tier);
    return structuredWithRepair(schema, async (extraInstruction) => {
      const response = await this.call(tier, model, (signal) =>
        postJson<ChatResponse>(
          `${this.baseUrl}/chat/completions`,
          this.headers,
          {
            model,
            // ALWAYS deterministic sampling (decision 0035): structured
            // extraction decides what Cogeto remembers — never a dice roll.
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system' as const, content: request.system },
              {
                role: 'user' as const,
                content: extraInstruction
                  ? `${request.input}\n\n${extraInstruction}`
                  : request.input,
              },
            ],
          },
          signal,
        ),
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
      const response = await this.call('embedding', this.embedModel, (signal) =>
        postJson<EmbeddingsResponse>(
          `${this.baseUrl}/embeddings`,
          this.headers,
          { model: this.embedModel, input: batch },
          signal,
        ),
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
    // A local runtime is probed on its native tags endpoint (decision 0041
    // ruling 2) — the health surface reports the runtime's reachability.
    const target = this.localRuntime
      ? { url: `${this.localRuntime.rootUrl}/api/tags`, what: 'ollama runtime' }
      : { url: `${this.baseUrl}/models`, what: 'openai-compatible endpoint' };
    let value: GatewayReachability;
    try {
      const response = await fetch(target.url, {
        headers: this.headers,
        signal: AbortSignal.timeout(5000),
      });
      value = response.ok
        ? { ok: true, detail: `${target.what} reachable` }
        : { ok: false, error: `${target.what} unreachable: HTTP ${response.status}` };
    } catch (error) {
      value = {
        ok: false,
        error: `${target.what} unreachable: ${error instanceof Error ? error.name : 'error'}`,
      };
    }
    this.reachabilityCache = { at: now, value };
    return value;
  }
}

/** Node's fetch surfaces an elapsed AbortSignal.timeout as a TimeoutError
 * DOMException (sometimes an AbortError depending on the phase). */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
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
