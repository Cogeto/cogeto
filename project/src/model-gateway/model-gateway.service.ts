import type { ZodType } from 'zod';

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
  /** Requests JSON output, parses it, and validates it against the Zod schema. */
  abstract extractStructured<T>(
    schema: ZodType<T>,
    request: StructuredExtractionRequest,
  ): Promise<T>;
  abstract embed(texts: string[]): Promise<number[][]>;
}
