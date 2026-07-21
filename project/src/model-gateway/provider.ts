import { ZodError } from 'zod';
import type { ZodType } from 'zod';
import { ModelGatewayError } from './errors';

/**
 * Shared provider plumbing (decision 0040 rulings 1–2): the retry/error
 * classification, the fetch-based HTTP + SSE transport the non-SDK adapters
 * use, and the ONE structured-output repair loop every adapter goes through.
 * Module-private to the gateway — nothing here is exported from the index.
 */

export const MAX_RETRIES = 5;
export const RETRY_BASE_MS = 800;
/** Reachability probe cache window (QS-35) — health polls reuse it. */
export const REACHABILITY_TTL_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** HTTP failure from a fetch-based adapter; carries the status for classification. */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

export function extractStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    const candidate =
      (error as { statusCode?: unknown }).statusCode ?? (error as { status?: unknown }).status;
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}

/** 429/5xx/network are retryable; any other HTTP status is fatal (ruling 1). */
export const isRetryableStatus = (status: number | undefined): boolean =>
  status === undefined || status === 429 || status >= 500;

export interface RetryPolicy {
  maxRetries?: number;
  baseMs?: number;
}

/**
 * Maps provider/network failures to typed errors with a retryable flag, and
 * retries retryable ones (429 rate-limits, 5xx, network) with exponential
 * backoff before giving up — identical semantics for every provider.
 */
export async function callWithRetry<T>(
  provider: string,
  fn: () => Promise<T>,
  policy: RetryPolicy = {},
): Promise<T> {
  const maxRetries = policy.maxRetries ?? MAX_RETRIES;
  const baseMs = policy.baseMs ?? RETRY_BASE_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = extractStatus(error);
      const retryable = isRetryableStatus(status);
      if (retryable && attempt < maxRetries) {
        await sleep(baseMs * 2 ** attempt);
        continue;
      }
      throw new ModelGatewayError(
        `${provider} call failed${status ? ` (HTTP ${status})` : ''}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        retryable,
        error,
      );
    }
  }
}

/** Pull a short, content-free error description out of a provider error body. */
async function describeErrorBody(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown; type?: unknown };
      message?: unknown;
    };
    const message = body.error?.message ?? body.message ?? body.error?.type;
    if (typeof message === 'string' && message) return message.slice(0, 200);
  } catch {
    // Non-JSON error body — the status alone is the message.
  }
  return response.statusText || 'request failed';
}

/** POST JSON and parse the JSON response; non-2xx throws a ProviderHttpError. */
export async function postJson<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ProviderHttpError(await describeErrorBody(response), response.status);
  }
  return (await response.json()) as T;
}

/** POST JSON and return the raw streaming response; non-2xx throws typed. */
export async function postStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ProviderHttpError(await describeErrorBody(response), response.status);
  }
  return response;
}

/** Yield the `data:` payload strings of an SSE response body, in order. */
export async function* sseData(response: Response): AsyncGenerator<string> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data:')) yield tail.slice(5).trim();
}

/** Strip a Markdown code fence a model may wrap around its JSON answer. */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fenced?.[1]?.trim() ?? trimmed;
}

/**
 * The ONE structured-output contract (decision 0040 ruling 2): parse the
 * adapter's JSON text, validate against the Zod schema, and on a schema
 * violation retry EXACTLY once with the validation issues appended. Non-JSON
 * output and a second schema failure are fatal typed errors; provider errors
 * keep their callWithRetry classification.
 */
export async function structuredWithRepair<T>(
  schema: ZodType<T, unknown>,
  attempt: (extraInstruction?: string) => Promise<string>,
): Promise<T> {
  const parseAndValidate = (text: string): T => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFence(text));
    } catch {
      throw new ModelGatewayError('model returned non-JSON output', false);
    }
    return schema.parse(parsed);
  };

  try {
    return parseAndValidate(await attempt());
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      try {
        return parseAndValidate(
          await attempt(
            `The previous JSON answer failed validation (${issues}). Answer again with JSON matching the required shape exactly.`,
          ),
        );
      } catch (secondError) {
        if (secondError instanceof ZodError) {
          throw new ModelGatewayError(
            `structured output failed schema validation twice: ${issues}`,
            false,
            secondError,
          );
        }
        throw secondError;
      }
    }
    throw error;
  }
}
