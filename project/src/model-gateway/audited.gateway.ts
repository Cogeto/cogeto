import { Logger } from '@nestjs/common';
import { ModelGatewayAbortedError } from './provider';
import { ModelGateway } from './model-gateway.service';
import type {
  CompletionRequest,
  CompletionResult,
  GatewayReachability,
  ModelTier,
  StructuredExtractionRequest,
  VisionRequest,
  StreamDelta,
} from './model-gateway.service';
import type { ModelEgressAudit } from '../infrastructure/index';
import type { ZodType } from 'zod';

/**
 * Model egress, recorded (V2.0 item 3.7).
 *
 * The trail covered what the instance DID with what it remembered and, since
 * SEC-9, what left it as a passport export; it recorded nothing about the one
 * thing that leaves the box on ordinary use. In a product whose thesis is
 * "models are rented, knowledge is owned", "which of my content went to a
 * rented model, when, and to whom" is a question the audit surface has to be
 * able to answer, and it could not.
 *
 * One entry per call through the seam, so nothing can bypass it — the same
 * reason the redaction and budget decorators wrap here rather than per adapter.
 *
 * **Structural metadata only** (AGENTS.md, spec §4.2): the tier asked for, the
 * provider and resolved model it routed to, whether redaction was configured,
 * the character counts in and out, and whether the call succeeded. Never the
 * prompt, never the completion, never a fragment of either — the input length is
 * a number, and a number is not content.
 *
 * Volume: one row per model call, bounded by the per-user daily budget the
 * decorator below it enforces (SEC-10/SEC-18). Retention and export for the
 * trail as a whole are V2.4 item 7.4, which is also where the rest of the
 * read-audit coverage this item began lands.
 *
 * Failures NEVER surface: an audit write that throws would turn a completed
 * model call — already made, already paid for, already egressed — into a failed
 * one, and for a stream it would throw after the whole answer was yielded. It is
 * logged instead, exactly as the budget meter's accounting is.
 */
export class AuditedModelGateway extends ModelGateway {
  private readonly logger = new Logger(AuditedModelGateway.name);

  constructor(
    private readonly inner: ModelGateway,
    private readonly audit: ModelEgressAudit,
    /** Tier → provider + model, so the record names where the bytes went. */
    private readonly routes: Readonly<Record<string, { provider: string; model: string }>>,
    private readonly redacted: boolean,
  ) {
    super();
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    try {
      const result = await this.inner.complete(request);
      await this.record(
        'complete',
        request.tier ?? 'answer',
        started,
        {
          inputChars: request.input.length,
          outputChars: result.text.length,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
        },
        request.answerOption,
      );
      return result;
    } catch (error) {
      await this.recordFailure(
        'complete',
        request.tier ?? 'answer',
        started,
        error,
        request.answerOption,
      );
      throw error;
    }
  }

  async *completeStream(request: CompletionRequest): AsyncIterable<StreamDelta> {
    const started = Date.now();
    const tier = request.tier ?? 'answer';
    // Structural counts only, as ever — but BOTH channels moved over the wire,
    // so both count as egress volume (Part A).
    let outputChars = 0;
    let failure: unknown;
    try {
      for await (const delta of this.inner.completeStream(request)) {
        outputChars += delta.text.length;
        yield delta;
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // `finally`, not "after the loop": an SSE consumer that disconnects
      // mid-answer abandons the generator, and the prompt had already egressed
      // by then. The entry is written with what actually moved.
      // A user pressing Stop is not a provider failure (issue #532): counting
      // it as one would make the egress failure rate meaningless the moment
      // Stop got used. What egressed is still recorded, because the prompt
      // left the box either way.
      if (failure && !(failure instanceof ModelGatewayAbortedError))
        await this.recordFailure('completeStream', tier, started, failure, request.answerOption);
      else
        await this.record(
          'completeStream',
          tier,
          started,
          { inputChars: request.input.length, outputChars },
          request.answerOption,
        );
    }
  }

  async extractStructured<T>(
    schema: ZodType<T, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T> {
    const started = Date.now();
    try {
      const result = await this.inner.extractStructured(schema, request);
      await this.record('extractStructured', request.tier ?? 'pipeline', started, {
        inputChars: request.input.length,
        // The SHAPE's size, not its content: how much came back, nothing of what.
        outputChars: JSON.stringify(result).length,
      });
      return result;
    } catch (error) {
      await this.recordFailure('extractStructured', request.tier ?? 'pipeline', started, error);
      throw error;
    }
  }

  /**
   * Vision egress (V2.1 item 4.1). A page image leaving the box is the largest
   * single thing this instance ever sends to a rented model, and V2.0 item 3.7
   * put model egress in the trail precisely so that is inspectable.
   *
   * `imageBytes` is recorded instead of pretending an image has a character
   * count: it is the honest size of what moved. Structural only, as ever, so
   * nothing about what the page SHOWED reaches the trail.
   */
  override async describeImage(request: VisionRequest): Promise<CompletionResult> {
    const started = Date.now();
    try {
      const result = await this.inner.describeImage(request);
      await this.record('describeImage', 'vision', started, {
        inputChars: request.input.length,
        imageBytes: request.image.bytes.length,
        outputChars: result.text.length,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
      });
      return result;
    } catch (error) {
      await this.recordFailure('describeImage', 'vision', started, error);
      throw error;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const started = Date.now();
    const inputChars = texts.reduce((total, text) => total + text.length, 0);
    try {
      const vectors = await this.inner.embed(texts);
      await this.record('embed', 'embedding', started, { inputChars, items: texts.length });
      return vectors;
    } catch (error) {
      await this.recordFailure('embed', 'embedding', started, error);
      throw error;
    }
  }

  embeddingModelId(): string {
    return this.inner.embeddingModelId();
  }

  override async reachable(): Promise<GatewayReachability> {
    // A probe is not egress of anyone's content: it carries no input and
    // belongs to the health surface, which has its own reporting.
    return this.inner.reachable();
  }

  private async record(
    operation: string,
    tier: ModelTier | 'embedding' | 'vision',
    started: number,
    detail: Record<string, number | undefined>,
    answerOption?: string,
  ): Promise<void> {
    await this.write(operation, tier, started, { ...detail, ok: true }, answerOption);
  }

  private async recordFailure(
    operation: string,
    tier: ModelTier | 'embedding' | 'vision',
    started: number,
    error: unknown,
    answerOption?: string,
  ): Promise<void> {
    // The error's CLASS, never its message: upstream messages carry endpoint
    // hosts and, on a validation failure, fragments of the model's own output.
    await this.write(
      operation,
      tier,
      started,
      {
        ok: false,
        errorClass: error instanceof Error ? error.constructor.name : 'unknown',
      },
      answerOption,
    );
  }

  private async write(
    operation: string,
    tier: string,
    started: number,
    detail: Record<string, unknown>,
    answerOption?: string,
  ): Promise<void> {
    // A user-chosen answer model is the model that actually received the bytes
    // (V2.4 item 7.1), so the trail must name it rather than the tier's
    // assigned default. An option that has since been retired falls back to the
    // tier route, which is what the router did with the call itself.
    const route =
      (answerOption ? this.routes[`answer:${answerOption}`] : undefined) ?? this.routes[tier];
    try {
      await this.audit.recordEgress({
        operation,
        tier,
        provider: route?.provider ?? null,
        model: route?.model ?? null,
        redacted: this.redacted,
        latencyMs: Date.now() - started,
        detail,
      });
    } catch (error) {
      this.logger.warn(
        `model egress not recorded (${operation}/${tier}): ` +
          `${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
