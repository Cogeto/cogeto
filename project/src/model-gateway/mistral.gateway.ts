import { Mistral } from '@mistralai/mistralai';
import type { ZodType } from 'zod';
import { ModelGateway } from './model-gateway.service';
import type {
  CompletionRequest,
  CompletionResult,
  GatewayReachability,
  StructuredExtractionRequest,
  TokenUsage,
  StreamDelta,
} from './model-gateway.service';
import {
  ModelGatewayError,
  ModelGatewayNotConfiguredError,
  ReasoningExhaustedBudgetError,
  VisionUnavailableError,
} from './errors';
import type { ModelTier, VisionRequest } from './model-gateway.service';
import {
  callWithRetry,
  extractStatus,
  REACHABILITY_TTL_MS,
  structuredWithRepair,
} from './provider';
import { classifyVisionFailure } from './vision-failure';

export interface MistralGatewayOptions {
  apiKey: string;
  /** Model for the `pipeline` tier (extraction, verification). */
  pipelineModel?: string;
  /** Model for the `answer` tier (chat synthesis, eval grader). */
  answerModel?: string;
  embedModel?: string;
  /**
   * Model for the `vision` tier (reading a page that is a picture). No
   * default and no preset: unset means this adapter has no vision, which is a
   * complete answer, and the reading ladder stops at OCR and says so.
   */
  visionModel?: string;
  /**
   * maxTokens multiplier for a binding that has SHOWN it reasons (issue #573).
   * A cap sized for an answer is not sized for an answer plus its
   * deliberation, and a Magistral model that spends the budget thinking
   * returns nothing at all.
   */
  reasoningHeadroom?: number;
  /**
   * Sampling temperature for free-text completions. The eval
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
/** For failure messages only: the SDK owns the real base URL. */
const MISTRAL_API_LABEL = 'https://api.mistral.ai';

/**
 * The only place in the system that touches the Mistral client (spec §12.1) —
 * enforced by a dependency-cruiser rule. Maps model tiers (
 * ruling 3) to concrete Mistral models; callers never name a model string.
 * Retry/error classification and the structured repair loop are the shared
 * provider contract (–2).
 */
export class MistralModelGateway extends ModelGateway {
  private readonly client: Mistral;
  private readonly models: Record<ModelTier, string>;
  private readonly embedModel: string;
  private readonly visionModel?: string;
  private readonly reasoningHeadroom: number;
  /**
   * Which models have been OBSERVED reasoning, learned from their own
   * answers. Not a list of names: whether a binding reasons is a fact about
   * what came back, exactly as it is in the OpenAI-compatible adapter.
   */
  private readonly reasoningModels = new Set<string>();
  /**
   * Models that answered a `reasoning_effort` request with a 400 (issue #577).
   * Which parameters a model accepts is a server-side fact, learned from its
   * own refusal exactly as the OpenAI-compatible adapter learns its dialect,
   * because guessing from a model name is what this whole area keeps
   * getting wrong.
   */
  private readonly reasoningEffortRefused = new Set<string>();
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
    this.visionModel = options.visionModel;
    this.reasoningHeadroom = options.reasoningHeadroom ?? 4;
    this.temperature = options.temperature;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = this.models[request.tier ?? 'answer'];
    const response = await this.withReasoningEffort(model, () =>
      callWithRetry('mistral', () =>
        this.client.chat.complete({
          model,
          maxTokens: this.capFor(model, request.maxTokens),
          ...this.reasoningEffortField(model, request.thinking),
          ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
          messages: [
            ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
            { role: 'user' as const, content: request.input },
          ],
        }),
      ),
    );
    const content = response.choices?.[0]?.message?.content;
    const reasoned = this.noteReasoning(model, content);
    const text = contentToText(content);
    // The honest diagnosis (issue #573): an empty answer beside a non-empty
    // thinking block at `finish_reason: length` is a budget spent on
    // deliberation, not a broken model. Reporting "returned no text" sends the
    // reader to the network, which is the one place the problem is not.
    if (text.trim().length === 0 && reasoned && response.choices?.[0]?.finishReason === 'length') {
      throw new ReasoningExhaustedBudgetError(model, 'mistral', request.maxTokens);
    }
    return { text, ...(reasoned ? { reasoned: true } : {}), ...usageOf(response) };
  }

  async *completeStream(request: CompletionRequest): AsyncIterable<StreamDelta> {
    const streamModel = this.models[request.tier ?? 'answer'];
    const stream = await this.withReasoningEffort(streamModel, () =>
      callWithRetry('mistral', () =>
        this.client.chat.stream(
          {
            model: streamModel,
            maxTokens: this.capFor(streamModel, request.maxTokens),
            ...this.reasoningEffortField(streamModel, request.thinking),
            ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
            messages: [
              ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
              { role: 'user' as const, content: request.input },
            ],
          },
          {
            // The SDK's RequestOptions extends RequestInit, so the caller's Stop
            // reaches the underlying fetch and ends generation (issue #532).
            signal: request.signal,
          },
        ),
      ),
    );
    const model = streamModel;
    for await (const event of stream) {
      const content = event.data.choices?.[0]?.delta?.content;
      // Thinking is a CHANNEL, not content: it is shown as a live disclosure,
      // never captured, cited, verified or evaluated, and it must never be
      // concatenated into the answer (docs/features/reasoning.md).
      const thinking = thinkingToText(content);
      if (thinking) {
        this.reasoningModels.add(model);
        yield { channel: 'thinking', text: thinking };
      }
      const text = contentToText(content);
      if (text) yield { channel: 'text', text };
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
          // ALWAYS deterministic sampling: structured
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

  /**
   * Reads an image (issue #570).
   *
   * Vision was implemented in the OpenAI-compatible adapter only, and the
   * factory passed `visionModel` to that adapter alone, so a Mistral vision
   * assignment resolved and stored and then routed into an adapter with no
   * image path: every call fell through to the base class and reported "no
   * vision tier is configured for this instance", which is true of the adapter
   * and false of the instance, and sends an admin to the page they just used.
   *
   * A separate capability, not a parameter, for the same reason it is on the
   * OpenAI adapter: an unset vision model is a complete answer, and the reading
   * ladder stops at OCR and says so rather than failing inside a text call.
   */
  override async describeImage(request: VisionRequest): Promise<CompletionResult> {
    const model = this.visionModel;
    if (!model) {
      throw new VisionUnavailableError(
        'not_configured',
        'no vision model configured for provider "mistral"',
      );
    }
    const dataUrl = `data:${request.image.mediaType};base64,${request.image.bytes.toString('base64')}`;
    let response;
    try {
      response = await callWithRetry('mistral', () =>
        this.client.chat.complete({
          model,
          maxTokens: this.capFor(model, request.maxTokens),
          // Reading a page is transcription, not generation: deterministic,
          // like structured extraction and unlike chat.
          temperature: 0,
          messages: [
            ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
            {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: request.input },
                { type: 'image_url' as const, imageUrl: dataUrl },
              ],
            },
          ],
        }),
      );
    } catch (error) {
      // The same classification the OpenAI-compatible adapter uses, so an
      // admin gets the actionable reason (model refused the image, endpoint
      // unreachable, credentials rejected) rather than "vision failed".
      throw classifyVisionFailure(error, {
        label: 'mistral',
        model,
        endpoint: MISTRAL_API_LABEL,
        localRuntime: false,
      });
    }
    const content = response.choices?.[0]?.message?.content;
    const reasoned = this.noteReasoning(model, content);
    const text = contentToText(content);
    if (text.trim().length === 0) {
      // Same distinction as `complete` (issue #573): a vision binding can be a
      // reasoning model, and "accepted the image and returned no text" is a
      // false diagnosis when the budget went on thinking about it.
      if (reasoned && response.choices?.[0]?.finishReason === 'length') {
        throw new ReasoningExhaustedBudgetError(model, 'mistral', request.maxTokens);
      }
      throw new VisionUnavailableError(
        'unusable_response',
        `the vision model "${model}" on mistral accepted the image and returned no text`,
      );
    }
    return { text, ...(reasoned ? { reasoned: true } : {}), ...usageOf(response) };
  }

  /**
   * ASK for thinking (issue #577). Mistral surfaces a reasoning trace only
   * when the request says so: measured against the live API, a reasoning model
   * with no parameter returns a plain string and no thinking at all, and the
   * same question with `reasoning_effort: "high"` returns the think chunk this
   * adapter parses. Issue #573 built the receiving half and never this one, so
   * the chat toggle reached the adapter and was dropped.
   *
   * An ABSENT mode sends nothing. That is what keeps every non-chat caller
   * (research synthesis, skills, email drafts, the provider probe) byte-
   * identical: they never set a thinking mode, so they never pay for one.
   */
  private reasoningEffortField(
    model: string,
    mode: 'on' | 'off' | undefined,
  ): Record<string, unknown> {
    if (mode === undefined || this.reasoningEffortRefused.has(model)) return {};
    return { reasoningEffort: mode === 'on' ? 'high' : 'none' };
  }

  /**
   * One retry, once ever per model, when the endpoint refuses the parameter.
   * A model that does not take `reasoning_effort` must still answer: losing
   * every chat reply to a rejected optional field would be a far worse failure
   * than not thinking.
   */
  private async withReasoningEffort<T>(model: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const status =
        extractStatus(error) ?? extractStatus((error as { cause?: unknown } | undefined)?.cause);
      const message = error instanceof Error ? error.message : String(error);
      if (
        status === 400 &&
        /reasoning_effort|reasoningEffort/i.test(message) &&
        !this.reasoningEffortRefused.has(model)
      ) {
        this.reasoningEffortRefused.add(model);
        return call();
      }
      throw error;
    }
  }

  /**
   * Did this answer carry a thinking block? Learned from the answer itself,
   * never from the model's name: `mistral-medium` and `magistral-medium` are
   * one API call apart and nothing but the response says which deliberates.
   */
  private noteReasoning(model: string, content: unknown): boolean {
    if (thinkingToText(content).trim().length === 0) return false;
    this.reasoningModels.add(model);
    return true;
  }

  /**
   * The headroom multiplier: a model that has shown it reasons gets its
   * maxTokens multiplied, because the caller's number was sized for an answer
   * and the model now spends part of it thinking. A model that never has gets
   * the caller's number byte-identically.
   */
  private capFor(model: string, maxTokens: number | undefined): number | undefined {
    if (maxTokens === undefined) return undefined;
    return this.reasoningModels.has(model) ? maxTokens * this.reasoningHeadroom : maxTokens;
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
   * Cached reachability probe: one cheap `models.list` at most every
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
  async *completeStream(): AsyncIterable<StreamDelta> {
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
  // Not an error state for health: no provider configured is the normal
  // first-run state, distinct from a misconfigured or unreachable provider
  // (those come from a real gateway's probe and fail). Report it plainly and
  // stay ok so it does not degrade the whole instance.
  override async reachable(): Promise<GatewayReachability> {
    return {
      ok: true,
      detail:
        'no model provider configured; model features are off until an administrator ' +
        'adds one under Providers',
    };
  }
}

/**
 * The ANSWER text. A thinking chunk is deliberately not part of it: thinking is
 * a channel, and letting it through here would put deliberation into a stored
 * answer, past redaction and into citations (docs/features/reasoning.md).
 * It was already excluded by accident (a ThinkChunk carries `thinking`, not
 * `text`); issue #573 makes it a stated rule so the next chunk type added
 * upstream cannot leak in.
 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((chunk) =>
        typeof chunk === 'object' && chunk !== null && 'text' in chunk && !isThinkChunk(chunk)
          ? String((chunk as { text: unknown }).text)
          : '',
      )
      .join('');
  }
  return '';
}

const isThinkChunk = (chunk: unknown): boolean =>
  typeof chunk === 'object' && chunk !== null && (chunk as { type?: unknown }).type === 'thinking';

/**
 * The THINKING text (issue #573). Mistral models a reasoning turn as a
 * `ThinkChunk` in the message content: `{ type: 'thinking', thinking: [...] }`,
 * whose entries are ordinary text chunks. The adapter used to drop it on the
 * floor, which is why a Magistral model answered with no visible deliberation
 * and the reasoning capability probed `off` for every Mistral binding.
 */
function thinkingToText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(isThinkChunk)
    .map((chunk) => {
      const parts = (chunk as { thinking?: unknown }).thinking;
      if (typeof parts === 'string') return parts;
      if (!Array.isArray(parts)) return '';
      return parts
        .map((part) =>
          typeof part === 'object' && part !== null && 'text' in part
            ? String((part as { text: unknown }).text)
            : '',
        )
        .join('');
    })
    .join('');
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
