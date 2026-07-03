import { Mistral } from '@mistralai/mistralai';
import { ZodError } from 'zod';
import type { ZodType, ZodTypeDef } from 'zod';
import { ModelGateway } from './model-gateway.service';
import type {
  CompletionRequest,
  CompletionResult,
  StructuredExtractionRequest,
} from './model-gateway.service';
import { ModelGatewayError, ModelGatewayNotConfiguredError } from './errors';

export interface MistralGatewayOptions {
  apiKey: string;
  /** Chat model for completion + structured extraction. */
  model?: string;
  embedModel?: string;
}

const DEFAULT_MODEL = 'mistral-small-latest';
const DEFAULT_EMBED_MODEL = 'mistral-embed';
const EMBED_BATCH_SIZE = 128;

/**
 * The only place in the system that touches the Mistral client (§A.10) —
 * enforced by a dependency-cruiser rule.
 */
export class MistralModelGateway extends ModelGateway {
  private readonly client: Mistral;
  private readonly model: string;
  private readonly embedModel: string;

  constructor(options: MistralGatewayOptions) {
    super();
    this.client = new Mistral({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_MODEL;
    this.embedModel = options.embedModel ?? DEFAULT_EMBED_MODEL;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await this.call(() =>
      this.client.chat.complete({
        model: this.model,
        maxTokens: request.maxTokens,
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
        model: this.model,
        maxTokens: request.maxTokens,
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
    schema: ZodType<T, ZodTypeDef, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T> {
    const attempt = async (extraInstruction?: string): Promise<T> => {
      const response = await this.call(() =>
        this.client.chat.complete({
          model: this.model,
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

  /** Maps provider/network failures to typed errors with a retryable flag. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const status = extractStatus(error);
      const retryable = status === undefined || status === 429 || status >= 500;
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
