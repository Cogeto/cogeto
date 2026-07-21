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
      'model gateway is not configured (set COGETO_MISTRAL_API_KEY, or a COGETO_PROVIDER_* configuration — decision 0040)',
      false,
    );
    this.name = 'ModelGatewayNotConfiguredError';
  }
}

/**
 * The caller has spent their daily per-user model budget (FIX-2 QS-2). Not
 * retryable (the cap resets at UTC midnight); surfaced to the user as a
 * "limit reached" 429 (HTTP) or a distinct SSE error event (chat stream).
 */
export class ModelBudgetExceededError extends ModelGatewayError {
  constructor() {
    super('daily usage limit reached — please try again tomorrow', false);
    this.name = 'ModelBudgetExceededError';
  }
}
