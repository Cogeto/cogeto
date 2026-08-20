import type { ZodType } from 'zod';
import { ModelGateway } from './model-gateway.service';
import type {
  CompletionRequest,
  CompletionResult,
  GatewayReachability,
  StructuredExtractionRequest,
  VisionRequest,
  StreamDelta,
} from './model-gateway.service';
import type { LiveModelConfiguration } from './live-configuration';
import type { ResolvedModelProviders } from './provider-config';

/**
 * The gateway that follows the live configuration (V2.4 item 7.1).
 *
 * Before providers lived in the database, the whole decorated stack was built
 * once at boot from an immutable value, and that was correct: nothing could
 * change it without restarting the process. Now an admin can reassign a tier in
 * the interface and a user can pick their own answer model, and a stack built
 * once would keep talking to the endpoint the instance was started with.
 *
 * So the stack is REBUILT, not patched, whenever the configuration's version
 * changes: same factory, same decorator order, same everything. Rebuilding is
 * cheap (the adapters are fetch wrappers with no sockets of their own) and it
 * is the only way the redaction, budget and audit decorators can be guaranteed
 * to wrap a reloaded configuration exactly as they wrapped the one before it.
 *
 * A call already in flight keeps the stack it started on. That is deliberate:
 * swapping an adapter under a half-streamed answer would be worse than
 * finishing it on the configuration it began with.
 */
export class ReloadingModelGateway extends ModelGateway {
  private built?: { version: number; gateway: ModelGateway };

  constructor(
    private readonly live: LiveModelConfiguration,
    private readonly build: (providers: ResolvedModelProviders) => ModelGateway,
  ) {
    super();
  }

  /** The stack for the current configuration version, rebuilt on a change. */
  private get inner(): ModelGateway {
    const providers = this.live.current;
    if (this.built?.version !== providers.version) {
      // A copy, so the stack a call is running on cannot change under it when
      // the holder mutates the live object in place.
      this.built = { version: providers.version, gateway: this.build({ ...providers }) };
    }
    return this.built.gateway;
  }

  complete(request: CompletionRequest): Promise<CompletionResult> {
    return this.inner.complete(request);
  }

  completeStream(request: CompletionRequest): AsyncIterable<StreamDelta> {
    return this.inner.completeStream(request);
  }

  extractStructured<T>(
    schema: ZodType<T, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T> {
    return this.inner.extractStructured(schema, request);
  }

  override describeImage(request: VisionRequest): Promise<CompletionResult> {
    return this.inner.describeImage(request);
  }

  embed(texts: string[]): Promise<number[][]> {
    return this.inner.embed(texts);
  }

  embeddingModelId(): string {
    return this.inner.embeddingModelId();
  }

  override embeddingGeometryId(): string {
    return this.inner.embeddingGeometryId();
  }

  override reachable(): Promise<GatewayReachability> {
    return this.inner.reachable();
  }
}
