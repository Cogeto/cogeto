import type { ZodType } from 'zod';
import { ModelGateway } from './model-gateway.service';
import type {
  CompletionRequest,
  CompletionResult,
  GatewayReachability,
  ModelTier,
  StructuredExtractionRequest,
  TokenUsage,
  VisionRequest,
} from './model-gateway.service';
import { ModelGatewayError, ReasoningExhaustedBudgetError, VisionUnavailableError } from './errors';
import {
  callWithRetry,
  postJson,
  postStream,
  REACHABILITY_TTL_MS,
  sseData,
  structuredWithRepair,
} from './provider';
import { DEFAULT_OPENAI_BASE_URL } from './provider-config';
import { classifyVisionFailure } from './vision-failure';

export interface OpenAiCompatibleGatewayOptions {
  apiKey: string;
  /** Any OpenAI-compatible endpoint — the doorway the
   * local runtime walks through. Default: the OpenAI API. */
  baseUrl?: string;
  /** Models per tier — no defaults: configuration must name them (ruling 3). */
  pipelineModel?: string;
  answerModel?: string;
  embedModel?: string;
  /** The image model (V2.1 item 4.1); absent → this adapter has no vision. */
  visionModel?: string;
  /** Sampling temperature for free-text completions; structured
   * extraction is ALWAYS temperature 0. */
  temperature?: number;
  /** Provider name used in error messages and retry logs'ollama' for the
   * local flavor; defaults to 'openai'. */
  providerLabel?: string;
  /**
   * Per-tier request timeouts — local inference on
   * consumer hardware needs seconds-to-minutes, independently per tier. Absent
   * (every hosted configuration): no explicit timeout, byte-identical to
   * behavior. A timed-out call is FATAL, not retryable — retrying a
   * saturated local runtime only piles on.
   */
  tierTimeoutsMs?: { pipeline?: number; answer?: number; embedding?: number; vision?: number };
  /**
   * Marks this instance as a LOCAL Ollama runtime: `rootUrl`
   * is the runtime root; `reachable` probes `<root>/api/tags`, and an HTTP
   * 404 model-not-found becomes a fatal, actionable error naming the missing
   * model and the `ollama pull` command.
   */
  localRuntime?: { rootUrl: string };
  /**
   * maxTokens multiplier for models that returned a separate reasoning field
   * (Part B of reasoning support). Applied per model, and ONLY after a real
   * response carried the field — never off a name or a flag, for the same
   * reason vision is probed. Default 4; a model that never reasons never sees
   * a changed request.
   */
  reasoningHeadroom?: number;
}

const EMBED_BATCH_SIZE = 128;

/**
 * The assistant message, with the reasoning field names servers actually use:
 * `reasoning_content` (llama.cpp, DeepSeek), `reasoning` (OpenAI-style
 * surfaces), `thinking` (Ollama). Typing them is the point (Part B of
 * reasoning support): the reasoning text is read ONLY to answer "did this
 * model reason?" and to detect the exhausted-budget failure — it never joins
 * the answer text, never reaches a JSON parser, and is dropped here.
 */
interface ChatMessage {
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
  thinking?: unknown;
}

interface ChatResponse {
  choices?: { message?: ChatMessage; finish_reason?: unknown }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

interface EmbeddingsResponse {
  data?: { embedding?: number[] }[];
}

/**
 * OpenAI-compatible adapter: base URL + key + model names over
 * plain HTTPS — no SDK dependency, and deliberately compatible with any server
 * speaking the OpenAI chat/embeddings API shape. The only place in the system
 * that talks to such an endpoint (spec §12.1; `no_provider_leakage`).
 */
export class OpenAiCompatibleModelGateway extends ModelGateway {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly models: Partial<Record<ModelTier, string>>;
  private readonly embedModel?: string;
  private readonly visionModel?: string;
  private readonly temperature?: number;
  private readonly label: string;
  private readonly tierTimeoutsMs?: OpenAiCompatibleGatewayOptions['tierTimeoutsMs'];
  private readonly localRuntime?: { rootUrl: string };
  private readonly reasoningHeadroom: number;
  /**
   * Models a response has shown to reason, learned from real responses only:
   * the boot/registry probe primes it, and any non-streaming response carrying
   * a reasoning field keeps it current. Per model, so a mixed configuration
   * (one binding reasons, another does not) applies headroom exactly where the
   * evidence is.
   */
  private readonly reasoningModels = new Set<string>();
  private reachabilityCache?: { at: number; value: GatewayReachability };

  constructor(options: OpenAiCompatibleGatewayOptions) {
    super();
    this.baseUrl = (options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/, '');
    this.headers = { authorization: `Bearer ${options.apiKey}` };
    this.models = { pipeline: options.pipelineModel, answer: options.answerModel };
    this.embedModel = options.embedModel;
    this.visionModel = options.visionModel;
    this.temperature = options.temperature;
    this.label = options.providerLabel ?? 'openai';
    this.tierTimeoutsMs = options.tierTimeoutsMs;
    this.localRuntime = options.localRuntime;
    this.reasoningHeadroom = options.reasoningHeadroom ?? 4;
  }

  /**
   * Records whether this response carried a separate reasoning field and
   * discards its text in the same breath. Returns the bare fact; the text
   * never leaves this method — thinking is a channel, not content, and Part B
   * deliberately does not build the channel.
   */
  private noteReasoning(model: string, message: ChatMessage | undefined): boolean {
    if (!message) return false;
    const reasoningText = contentToText(
      message.reasoning_content ?? message.reasoning ?? message.thinking,
    );
    if (reasoningText.trim().length === 0) return false;
    this.reasoningModels.add(model);
    return true;
  }

  /**
   * The headroom multiplier (Part B): a cap sized for an answer is not sized
   * for an answer plus its deliberation, so a model that has shown it reasons
   * gets its maxTokens multiplied. A model that never has gets the caller's
   * number byte-identically.
   */
  private capFor(model: string, maxTokens: number | undefined): number | undefined {
    if (maxTokens === undefined) return undefined;
    return this.reasoningModels.has(model) ? maxTokens * this.reasoningHeadroom : maxTokens;
  }

  /**
   * The honest failure (Part B): empty answer + non-empty reasoning +
   * `finish_reason: length` means the model spent the whole output budget on
   * reasoning. Surfacing that as "returned no text" sends the reader to the
   * network or the projector, and the problem is in neither place.
   */
  private assertNotExhaustedByReasoning(
    model: string,
    response: ChatResponse,
    text: string,
    reasoned: boolean,
    maxTokens: number | undefined,
  ): void {
    if (text.trim().length === 0 && reasoned && response.choices?.[0]?.finish_reason === 'length') {
      throw new ReasoningExhaustedBudgetError(model, this.label, maxTokens);
    }
  }

  private modelFor(tier: ModelTier): string {
    const model = this.models[tier];
    if (!model) {
      throw new ModelGatewayError(`no ${tier}-tier model configured for this provider`, false);
    }
    return model;
  }

  /**
   * One retried call with the local-inference realities applied (
   * ruling 2): the tier's timeout (fresh abort signal per attempt; a timeout is
   * fatal with the variable to raise), and — on a local runtime — HTTP 404
   * model-not-found rethrown fatal with the exact `ollama pull` fix.
   */
  private async call<T>(
    tier: 'pipeline' | 'answer' | 'embedding' | 'vision',
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
              `${this.label} ${tier} call timed out after ${timeoutMs} ms, raise ` +
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
            `${this.localRuntime.rootUrl}, run \`ollama pull ${model}\` on the Ollama host`,
          false,
          error,
        );
      }
      throw error;
    }
  }

  private chatBody(request: CompletionRequest, extra: Record<string, unknown> = {}): object {
    const model = this.modelFor(request.tier ?? 'answer');
    const maxTokens = this.capFor(model, request.maxTokens);
    return {
      model,
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
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
    const model = this.modelFor(tier);
    const response = await this.call(tier, model, (signal) =>
      postJson<ChatResponse>(
        `${this.baseUrl}/chat/completions`,
        this.headers,
        this.chatBody(request),
        signal,
      ),
    );
    const message = response.choices?.[0]?.message;
    const reasoned = this.noteReasoning(model, message);
    const text = contentToText(message?.content);
    this.assertNotExhaustedByReasoning(model, response, text, reasoned, request.maxTokens);
    return {
      text,
      ...(reasoned ? { reasoned: true } : {}),
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
            // ALWAYS deterministic sampling: structured
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
      // The reasoning field is DISCARDED here, before the JSON parser ever
      // runs (Part B): only `content` may reach schema validation, because a
      // model's private reasoning must be structurally unable to become a
      // stored fact. `noteReasoning` reads it solely as a yes/no.
      const message = response.choices?.[0]?.message;
      const reasoned = this.noteReasoning(model, message);
      const text = contentToText(message?.content);
      this.assertNotExhaustedByReasoning(model, response, text, reasoned, undefined);
      return text;
    });
  }

  /**
   * Reads one image (V2.1 item 4.1).
   *
   * The OpenAI chat shape carries images as content PARTS with a `data:` URL,
   * and both OpenAI and Ollama's compatible surface accept exactly that, so no
   * provider-specific branch appears here. The bytes are inlined rather than
   * given as a link: the model must never be handed a URL it would fetch, which
   * would be an egress path the instance does not control.
   *
   * Failure classification is the point of this method. An endpoint that
   * answers and REFUSES the image is a different fact from one that is down,
   * and for a local runtime it usually means one specific thing: the model was
   * loaded without its multimodal projector. The same GGUF serves happily as a
   * text model, and nothing in its name says which way it was loaded, so the
   * message says it outright instead of leaving the operator to guess.
   */
  override async describeImage(request: VisionRequest): Promise<CompletionResult> {
    const model = this.visionModel;
    if (!model) {
      throw new VisionUnavailableError(
        'not_configured',
        `no vision model configured for provider "${this.label}"`,
      );
    }
    const dataUrl = `data:${request.image.mediaType};base64,${request.image.bytes.toString('base64')}`;
    // Headroom applies here too (Part B): the vision binding can be the same
    // reasoning model as the text tiers, and a cap sized for a page transcript
    // is not sized for the transcript plus the model's deliberation about it.
    const maxTokens = this.capFor(model, request.maxTokens);
    const body = {
      model,
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      // Reading a page is a transcription task, not a creative one.
      temperature: 0,
      messages: [
        ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
        {
          role: 'user' as const,
          content: [
            { type: 'text', text: request.input },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    };

    let response: ChatResponse;
    try {
      response = await this.call('vision', model, (signal) =>
        postJson<ChatResponse>(`${this.baseUrl}/chat/completions`, this.headers, body, signal),
      );
    } catch (error) {
      throw classifyVisionFailure(error, {
        label: this.label,
        model,
        endpoint: this.baseUrl,
        localRuntime: this.localRuntime !== undefined,
      });
    }

    const message = response.choices?.[0]?.message;
    const reasoned = this.noteReasoning(model, message);
    const text = contentToText(message?.content);
    if (text.trim().length === 0) {
      // The honest diagnosis first (Part B): an empty answer beside a
      // non-empty reasoning field at `finish_reason: length` is a token
      // budget spent on reasoning, not a projector or network fault, and
      // "returned no text" would send the operator to both wrong places.
      if (reasoned && response.choices?.[0]?.finish_reason === 'length') {
        throw new VisionUnavailableError(
          'reasoning_exhausted',
          `the vision model "${model}" on ${this.label} accepted the image and spent its ` +
            `entire output budget${request.maxTokens !== undefined ? ` (max_tokens ${request.maxTokens})` : ''} ` +
            `on reasoning before any answer text: raise the caller's maxTokens or ` +
            `COGETO_REASONING_HEADROOM`,
        );
      }
      throw new VisionUnavailableError(
        'unusable_response',
        `the vision model "${model}" on ${this.label} accepted the image and returned no text`,
      );
    }
    return { text, ...(reasoned ? { reasoned: true } : {}), ...usageOf(response) };
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
    // A local runtime is probed on its native tags endpoint (
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
