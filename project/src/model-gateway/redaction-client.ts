import { ModelGatewayError } from './errors';

/**
 * The redaction seam (Addendum B.8; decision 0002 language boundary). The ONLY
 * caller of the Python sidecar — it is not exported from the module index, so no
 * other module can reach it. Stateless: /pseudonymize returns the mapping, which
 * the gateway holds in memory for the one call.
 *
 * Fail-closed: any transport/HTTP failure throws a ModelGatewayError, so a model
 * call whose text could not be redacted NEVER proceeds in plaintext.
 */

export interface RedactionResult {
  text: string;
  mapping: Record<string, string>;
}

/** The port the RedactingModelGateway depends on (fakeable in tests). */
export interface RedactionPort {
  pseudonymize(text: string): Promise<RedactionResult>;
  health(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class RedactionClient implements RedactionPort {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async pseudonymize(text: string): Promise<RedactionResult> {
    const body = await this.post('/pseudonymize', { text });
    const mapping = body.mapping;
    if (typeof body.text !== 'string' || typeof mapping !== 'object' || mapping === null) {
      throw new ModelGatewayError('redaction sidecar returned a malformed response', false);
    }
    return { text: body.text, mapping: mapping as Record<string, string> };
  }

  async health(): Promise<void> {
    await this.request('GET', '/health');
  }

  private async post(
    path: string,
    payload: unknown,
  ): Promise<{ text?: unknown; mapping?: unknown }> {
    const res = await this.request('POST', path, payload);
    return (await res.json()) as { text?: unknown; mapping?: unknown };
  }

  private async request(method: string, path: string, payload?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        signal: controller.signal,
        ...(payload !== undefined
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
          : {}),
      });
      if (!res.ok) {
        // Fail closed: redaction is enabled but the sidecar rejected the request.
        throw new ModelGatewayError(
          `redaction sidecar ${method} ${path} → HTTP ${res.status}`,
          false,
        );
      }
      return res;
    } catch (error) {
      if (error instanceof ModelGatewayError) throw error;
      // Unreachable / timed out / aborted — fail closed, never send plaintext.
      throw new ModelGatewayError(
        `redaction sidecar unreachable (${method} ${path}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        false,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
