/** Typed gateway errors: callers branch on `retryable`, never on provider types. */
export class ModelGatewayError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ModelGatewayError';
  }
}

export class ModelGatewayNotConfiguredError extends ModelGatewayError {
  constructor() {
    super(
      'model gateway is not configured (set COGETO_MISTRAL_API_KEY, or a COGETO_PROVIDER_* configuration)',
      false,
    );
    this.name = 'ModelGatewayNotConfiguredError';
  }
}

/**
 * Why vision is not available (V2.1 item 4.1). These four are kept apart
 * because they send an operator to four different places, and a generic
 * "vision failed" sends them to the wrong one:
 *
 * - `not_configured` — no vision tier in this instance's configuration.
 * - `unreachable` — the endpoint did not answer.
 * - `image_rejected` — the endpoint answered and refused the IMAGE. On a local
 *   runtime this almost always means the model is being served without its
 *   multimodal projector: the same GGUF weights run happily as a text model,
 *   and nothing in the model's name says which way it was loaded.
 * - `probe_timeout` — it did not answer within the probe's deadline. Kept apart
 *   from `unreachable` because a remote GPU warming a vision model is slow, not
 *   broken, and reporting it as unreachable sends an operator to look at the
 *   network when the fix is a larger number.
 * - `unusable_response` — it answered, took the image, and returned nothing
 *   a reader could use.
 * - `refused_by_policy` — a local rule forbids the call. Redaction is the case
 *   that exists: pixels cannot be pseudonymized, so with redaction enabled a
 *   vision call would be the one path that sends unredacted content out.
 * - `reasoning_exhausted` — the model took the image and spent its ENTIRE
 *   output budget on reasoning, so the answer text never started. This is a
 *   token-budget fact, not a network or projector fault: the fix is a larger
 *   max_tokens (the reasoning headroom multiplier applies it automatically once
 *   the reasoning capability is detected), and reporting it as "returned no
 *   text" sends the operator to the two places the problem is not.
 */
export type VisionUnavailableReason =
  | 'not_configured'
  | 'unreachable'
  | 'probe_timeout'
  | 'image_rejected'
  | 'unusable_response'
  | 'refused_by_policy'
  | 'reasoning_exhausted';

export class VisionUnavailableError extends ModelGatewayError {
  constructor(
    readonly reason: VisionUnavailableReason,
    message: string,
    cause?: unknown,
  ) {
    // Never retryable: every one of these is a configuration or capability
    // fact about the instance, and retrying an unloaded projector just burns
    // the pipeline's attempts.
    super(message, false, cause);
    this.name = 'VisionUnavailableError';
  }
}

/**
 * A reasoning model spent its entire output budget (`max_tokens`) on its
 * private reasoning and returned no answer text (Part B of reasoning support):
 * `content` came back empty, the reasoning field did not, and the provider
 * reported `finish_reason: length`.
 *
 * Named because the generic "returned no text" is a FALSE diagnosis here: the
 * endpoint is up and the model worked, the cap was simply sized for an answer
 * rather than an answer plus its deliberation. Not retryable — the same cap
 * produces the same result; the fix is a larger `maxTokens` or the reasoning
 * headroom multiplier (COGETO_REASONING_HEADROOM), which applies automatically
 * once the reasoning capability is detected.
 */
export class ReasoningExhaustedBudgetError extends ModelGatewayError {
  constructor(model: string, provider: string, maxTokens: number | undefined) {
    super(
      `the model "${model}" on ${provider} spent its entire output budget` +
        `${maxTokens !== undefined ? ` (max_tokens ${maxTokens})` : ''} on reasoning and ` +
        `returned no answer text: raise the caller's maxTokens or COGETO_REASONING_HEADROOM`,
      false,
    );
    this.name = 'ReasoningExhaustedBudgetError';
  }
}

/**
 * The caller has spent their daily per-user model budget. Not
 * retryable (the cap resets at UTC midnight); surfaced to the user as a
 * "limit reached" 429 (HTTP) or a distinct SSE error event (chat stream).
 */
export class ModelBudgetExceededError extends ModelGatewayError {
  constructor() {
    super('daily usage limit reached, please try again tomorrow', false);
    this.name = 'ModelBudgetExceededError';
  }
}
