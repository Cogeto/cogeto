import type { ZodType } from 'zod';
import { ModelGateway } from './model-gateway.service';
import type {
  CompletionRequest,
  CompletionResult,
  GatewayReachability,
  StructuredExtractionRequest,
} from './model-gateway.service';
import type { RedactionPort } from './redaction-client';
import { reidentifyDeep, reidentifyStream, reidentifyText } from './redaction-utils';

/**
 * Redaction mode (Addendum B.8; decisions 0002, 0023): a gateway decorator that
 * pseudonymizes the payload text BEFORE every outbound model call and
 * re-identifies the response BEFORE it reaches any caller. The wrapped gateway
 * (Mistral) only ever sees pseudonyms.
 *
 * - The `system` prompt is a versioned, PII-free artifact (§B.7) and is passed
 *   through untouched; only the `input` (the user/document/fact text) is redacted.
 * - Embeddings are redacted too (decision 0023): the embed call goes to Mistral,
 *   so leaving real entities in it would defeat redaction. There is nothing to
 *   re-identify (a vector), at a documented retrieval-quality cost.
 * - Fail-closed: `pseudonymize` runs first; if the sidecar is unreachable it
 *   throws, so the model call never happens with plaintext (RedactionClient).
 */
export class RedactingModelGateway extends ModelGateway {
  constructor(
    private readonly inner: ModelGateway,
    private readonly redactor: RedactionPort,
  ) {
    super();
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const { text: input, mapping } = await this.redactor.pseudonymize(request.input);
    const result = await this.inner.complete({ ...request, input });
    // Re-identify the text; provider-reported usage passes through untouched.
    return { ...result, text: reidentifyText(result.text, mapping) };
  }

  async *completeStream(request: CompletionRequest): AsyncIterable<string> {
    const { text: input, mapping } = await this.redactor.pseudonymize(request.input);
    yield* reidentifyStream(this.inner.completeStream({ ...request, input }), mapping);
  }

  async extractStructured<T>(
    schema: ZodType<T, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T> {
    const { text: input, mapping } = await this.redactor.pseudonymize(request.input);
    const result = await this.inner.extractStructured(schema, { ...request, input });
    // The model answered in pseudonym space; re-identify every string it produced.
    return reidentifyDeep(result, mapping);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Redact each text before it leaves for Mistral; vectors need no re-id.
    const redacted = await Promise.all(
      texts.map((text) => this.redactor.pseudonymize(text).then((r) => r.text)),
    );
    return this.inner.embed(redacted);
  }

  embeddingModelId(): string {
    return this.inner.embeddingModelId();
  }

  override async reachable(): Promise<GatewayReachability> {
    return this.inner.reachable(); // QS-35: probing is the wrapped gateway's job.
  }
}
