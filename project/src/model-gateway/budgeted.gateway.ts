import { ModelGateway } from './model-gateway.service';
import type {
  CompletionRequest,
  CompletionResult,
  GatewayReachability,
  StructuredExtractionRequest,
} from './model-gateway.service';
import { ModelBudgetExceededError } from './errors';
import type { ModelUsageMeter } from '../infrastructure/index';
import type { ZodType } from 'zod';

/**
 * Per-user daily model budget as a gateway decorator — the same
 * shape as the redaction decorator, so it wraps ALL model traffic uniformly.
 * Before each call it checks the attributed user (from the usage scope) is
 * under their daily call/token caps; after each call it records the estimated
 * usage.
 *
 * Security audit 2.0 SEC-10: the WORKER registers this decorator too, and its
 * task wrapper opens a usage scope from the enqueuing principal carried in the
 * job payload. Pipeline model traffic is therefore charged to the user who
 * caused it. Only work with no causing user — the recurring instance-wide
 * jobs, eval and the smokes — still passes through unattributed and unmetered.
 *
 * Tokens: `complete` charges the provider-REPORTED usage when the adapter
 * normalized one; everywhere else (streams,
 * structured extraction, embeddings — no usage channel in the seam's return
 * shapes) the documented ~4 chars/token ESTIMATE applies. A budget is a safety
 * ceiling, not billing, so the estimate remains sufficient where it is used.
 */
export class BudgetedModelGateway extends ModelGateway {
  constructor(
    private readonly inner: ModelGateway,
    private readonly meter: ModelUsageMeter,
  ) {
    super();
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const userId = await this.gate();
    const result = await this.inner.complete(request);
    if (userId && result.usage) {
      // Real provider-reported usage, normalized by the adapter (0040 r4).
      await this.meter.record(userId, result.usage.inputTokens + result.usage.outputTokens);
    } else {
      await this.charge(userId, request.input, result.text);
    }
    return result;
  }

  async *completeStream(request: CompletionRequest): AsyncIterable<string> {
    const userId = await this.gate();
    let output = '';
    for await (const delta of this.inner.completeStream(request)) {
      output += delta;
      yield delta;
    }
    await this.charge(userId, request.input, output);
  }

  async extractStructured<T>(
    schema: ZodType<T, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T> {
    const userId = await this.gate();
    const result = await this.inner.extractStructured(schema, request);
    await this.charge(userId, request.input, JSON.stringify(result));
    return result;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const userId = await this.gate();
    const vectors = await this.inner.embed(texts);
    await this.charge(userId, texts.join(''), '');
    return vectors;
  }

  embeddingModelId(): string {
    return this.inner.embeddingModelId();
  }

  override async reachable(): Promise<GatewayReachability> {
    return this.inner.reachable(); //: probing is the wrapped gateway's job.
  }

  /** Enforce the cap before a call; returns the user to charge (or undefined). */
  private async gate(): Promise<string | undefined> {
    const userId = this.meter.currentUserId();
    if (userId && !(await this.meter.hasBudget(userId))) throw new ModelBudgetExceededError();
    return userId;
  }

  private async charge(userId: string | undefined, input: string, output: string): Promise<void> {
    if (!userId) return;
    const tokens = Math.ceil((input.length + output.length) / 4);
    await this.meter.record(userId, tokens);
  }
}
