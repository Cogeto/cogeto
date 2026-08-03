import type { ZodType } from 'zod';
import { ModelGateway } from './model-gateway.service';
import { VisionUnavailableError } from './errors';
import type {
  CompletionRequest,
  CompletionResult,
  GatewayReachability,
  StructuredExtractionRequest,
} from './model-gateway.service';
import type { RedactionPort } from './redaction-client';
import { reidentifyDeep, reidentifyStream, reidentifyText } from './redaction-utils';

/**
 * Redaction mode (spec §12.2; 0023): a gateway decorator that
 * pseudonymizes the payload text BEFORE every outbound model call and
 * re-identifies the response BEFORE it reaches any caller. The wrapped gateway
 * (Mistral) only ever sees pseudonyms.
 *
 * - The `system` prompt is a versioned, PII-free artifact (spec §12.3) and is passed
 *   through untouched; only the `input` (the user/document/fact text) is redacted.
 * - Embeddings are redacted too: the embed call goes to Mistral,
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

  /**
   * Refuses (V2.1 item 4.1). Redaction's whole contract is that nothing leaves
   * the box carrying identities, and it keeps that contract by pseudonymizing
   * TEXT. A page image cannot be pseudonymized: the names are pixels, and this
   * decorator has no way to find or replace them.
   *
   * So with redaction enabled, a vision call would be the single path in the
   * product that sends unredacted content to a model. It fails closed, exactly
   * as an unreachable sidecar does, and the capability probe reports it as a
   * policy refusal rather than a broken endpoint, so the operator sees the
   * real reason instead of hunting a runtime that is working fine.
   */
  override async describeImage(): Promise<CompletionResult> {
    throw new VisionUnavailableError(
      'refused_by_policy',
      'redaction is enabled and an image cannot be pseudonymized: reading pages with a vision ' +
        'model would be the one path that sends unredacted content to a model, so it is refused. ' +
        'Run the reading ladder without vision, or disable redaction for this instance.',
    );
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
    return this.inner.reachable(); //: probing is the wrapped gateway's job.
  }
}
