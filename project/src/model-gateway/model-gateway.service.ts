import { Injectable, NotImplementedException } from '@nestjs/common';

/**
 * Provider-neutral model seam shapes (scope §5.1, §A.10): complete / embed /
 * rerank — never a wrapper around one vendor's types. v1 routes everything to
 * the Mistral API; implementation lands in S1-B.
 */
export interface CompletionRequest {
  promptFamily: string;
  promptVersion: string;
  input: string;
  maxTokens?: number;
}

export interface CompletionResult {
  text: string;
}

@Injectable()
export class ModelGateway {
  complete(_request: CompletionRequest): Promise<CompletionResult> {
    throw new NotImplementedException('S1-B: Mistral client behind the gateway seam');
  }

  embed(_texts: string[]): Promise<number[][]> {
    throw new NotImplementedException('S1-B: Mistral embeddings behind the gateway seam');
  }

  rerank(_query: string, _documents: string[]): Promise<number[]> {
    throw new NotImplementedException('v1.x: local reranker behind the gateway seam (§A.10)');
  }
}
