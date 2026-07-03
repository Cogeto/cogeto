import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Provider-neutral model seam (scope §5.1, §A.10): complete / extractStructured /
 * embed — never a wrapper around one vendor's types. Swapping backends may not
 * touch callers.
 */

export interface CompletionRequest {
  system?: string;
  input: string;
  maxTokens?: number;
}

export interface CompletionResult {
  text: string;
}

export interface StructuredExtractionRequest {
  /** The system prompt — a versioned artifact loaded via the prompt loader (§B.7). */
  system: string;
  input: string;
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
    schema: ZodType<T, ZodTypeDef, unknown>,
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
}
