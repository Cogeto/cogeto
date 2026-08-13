import type { ZodType } from 'zod';
import { ModelGateway } from './model-gateway.service';
import { VisionUnavailableError } from './errors';
import type {
  CompletionRequest,
  CompletionResult,
  GatewayReachability,
  StructuredExtractionRequest,
  VisionRequest,
  StreamDelta,
} from './model-gateway.service';

export interface TierRoutes {
  pipeline: ModelGateway;
  answer: ModelGateway;
  embedding: ModelGateway;
  /** Absent when this instance has no vision binding (V2.1 item 4.1). */
  vision?: ModelGateway | null;
  /**
   * The admin-enabled answer models a user may pick between (V2.4 item 7.1),
   * by option id. A request naming an option that is no longer enabled falls
   * back to the assigned answer tier rather than failing: an admin retiring an
   * option must not break the next question a user asks.
   */
  answerOptions?: ReadonlyMap<string, ModelGateway>;
}

/**
 * Per-tier provider routing: configurations are
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
    return this.forCompletion(request).complete(request);
  }

  completeStream(request: CompletionRequest): AsyncIterable<StreamDelta> {
    return this.forCompletion(request).completeStream(request);
  }

  /**
   * The adapter a completion goes to: the tier's, unless the caller named a
   * user-chosen answer option that is still enabled (V2.4 item 7.1). The call
   * site still names a TIER and an opaque option id, never a vendor model
   * string, so spec §12.1 holds.
   */
  private forCompletion(request: CompletionRequest): ModelGateway {
    const tier = request.tier ?? 'answer';
    if (tier === 'answer' && request.answerOption) {
      const chosen = this.routes.answerOptions?.get(request.answerOption);
      if (chosen) return chosen;
    }
    return this.routes[tier];
  }

  extractStructured<T>(
    schema: ZodType<T, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T> {
    return this.routes[request.tier ?? 'pipeline'].extractStructured(schema, request);
  }

  /** No vision route configured is a complete answer, not a missing one. */
  override describeImage(request: VisionRequest): Promise<CompletionResult> {
    if (!this.routes.vision) {
      throw new VisionUnavailableError(
        'not_configured',
        'no vision tier is configured: assign a vision provider and model (Models in the interface)',
      );
    }
    return this.routes.vision.describeImage(request);
  }

  embed(texts: string[]): Promise<number[][]> {
    return this.routes.embedding.embed(texts);
  }

  embeddingModelId(): string {
    return this.routes.embedding.embeddingModelId();
  }

  /**
   * Probe each DISTINCT underlying adapter serving a TIER; unreachable
   * anywhere → not ok. The user-selectable answer options are deliberately
   * excluded: they are optional extras, and one retired endpoint among them
   * must not make the instance report itself unhealthy.
   */
  override async reachable(): Promise<GatewayReachability> {
    const distinct = [
      ...new Set(
        [
          this.routes.pipeline,
          this.routes.answer,
          this.routes.embedding,
          this.routes.vision,
        ].filter((route): route is ModelGateway => route != null),
      ),
    ];
    const results = await Promise.all(distinct.map((gateway) => gateway.reachable()));
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      return { ok: false, error: failed.map((r) => r.error ?? 'unreachable').join('; ') };
    }
    return { ok: true, detail: results.map((r) => r.detail ?? 'reachable').join('; ') };
  }
}
