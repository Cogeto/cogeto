import type { ZodType } from 'zod';
import { ModelGateway } from './model-gateway.service';
import type {
  CompletionRequest,
  CompletionResult,
  GatewayReachability,
  StructuredExtractionRequest,
} from './model-gateway.service';

export interface TierRoutes {
  pipeline: ModelGateway;
  answer: ModelGateway;
  embedding: ModelGateway;
}

/**
 * Per-tier provider routing (decision 0040 ruling 1): configurations are
 * per-task-family, so each tier may resolve to a different provider adapter.
 * This router carries NO provider knowledge — it only dispatches by the tier
 * the caller already names (with the same defaults the seam documents) and
 * sits UNDER the redaction/budget decorators, so those stages apply
 * identically no matter which adapter serves a call.
 */
export class TierRoutedModelGateway extends ModelGateway {
  constructor(private readonly routes: TierRoutes) {
    super();
  }

  complete(request: CompletionRequest): Promise<CompletionResult> {
    return this.routes[request.tier ?? 'answer'].complete(request);
  }

  completeStream(request: CompletionRequest): AsyncIterable<string> {
    return this.routes[request.tier ?? 'answer'].completeStream(request);
  }

  extractStructured<T>(
    schema: ZodType<T, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T> {
    return this.routes[request.tier ?? 'pipeline'].extractStructured(schema, request);
  }

  embed(texts: string[]): Promise<number[][]> {
    return this.routes.embedding.embed(texts);
  }

  embeddingModelId(): string {
    return this.routes.embedding.embeddingModelId();
  }

  /** Probe each DISTINCT underlying adapter; unreachable anywhere → not ok. */
  override async reachable(): Promise<GatewayReachability> {
    const distinct = [...new Set(Object.values(this.routes))];
    const results = await Promise.all(distinct.map((gateway) => gateway.reachable()));
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      return { ok: false, error: failed.map((r) => r.error ?? 'unreachable').join('; ') };
    }
    return { ok: true, detail: results.map((r) => r.detail ?? 'reachable').join('; ') };
  }
}
