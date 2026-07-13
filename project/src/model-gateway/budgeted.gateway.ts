import { ModelGateway } from './model-gateway.service';
import type {
  CompletionRequest,
  CompletionResult,
  StructuredExtractionRequest,
} from './model-gateway.service';
import { ModelBudgetExceededError } from './errors';
import type { ModelUsageMeter } from '../infrastructure/index';
import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Per-user daily model budget (FIX-2 QS-2) as a gateway decorator — the same
 * shape as the redaction decorator, so it wraps ALL model traffic uniformly.
 * Before each call it checks the attributed user (from the per-request usage
 * scope) is under their daily call/token caps; after each call it records the
 * estimated usage. Unattributed calls (worker pipeline, eval, smokes) have no
 * user in scope and pass through unmetered.
 *
 * Tokens are ESTIMATED from character length (~4 chars/token) — the seam
 * abstracts away provider usage counts, and a budget is a safety ceiling, not
 * billing, so an estimate is sufficient and documented.
 */
export class BudgetedModelGateway extends ModelGateway {
  constructor(
    private readonly inner: ModelGateway,
    private readonly meter: ModelUsageMeter,
  ) {
    super();
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const userId = this.gate();
    const result = await this.inner.complete(request);
    this.charge(userId, request.input, result.text);
    return result;
  }

  async *completeStream(request: CompletionRequest): AsyncIterable<string> {
    const userId = this.gate();
    let output = '';
    for await (const delta of this.inner.completeStream(request)) {
      output += delta;
      yield delta;
    }
    this.charge(userId, request.input, output);
  }

  async extractStructured<T>(
    schema: ZodType<T, ZodTypeDef, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T> {
    const userId = this.gate();
    const result = await this.inner.extractStructured(schema, request);
    this.charge(userId, request.input, JSON.stringify(result));
    return result;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const userId = this.gate();
    const vectors = await this.inner.embed(texts);
    this.charge(userId, texts.join(''), '');
    return vectors;
  }

  embeddingModelId(): string {
    return this.inner.embeddingModelId();
  }

  /** Enforce the cap before a call; returns the user to charge (or undefined). */
  private gate(): string | undefined {
    const userId = this.meter.currentUserId();
    if (userId && !this.meter.hasBudget(userId)) throw new ModelBudgetExceededError();
    return userId;
  }

  private charge(userId: string | undefined, input: string, output: string): void {
    if (!userId) return;
    const tokens = Math.ceil((input.length + output.length) / 4);
    this.meter.record(userId, tokens);
  }
}
