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
    super('model gateway is not configured (set COGETO_MISTRAL_API_KEY)', false);
    this.name = 'ModelGatewayNotConfiguredError';
  }
}
