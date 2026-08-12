import { ZodError } from 'zod';
import type { ZodType } from 'zod';
import { ModelGatewayError } from './errors';

/**
 * Shared provider plumbing (–2): the retry/error
 * classification, the fetch-based HTTP + SSE transport the non-SDK adapters
 * use, and the ONE structured-output repair loop every adapter goes through.
 * Module-private to the gateway — nothing here is exported from the index.
 */

export const MAX_RETRIES = 5;
export const RETRY_BASE_MS = 800;
/** Reachability probe cache window — health polls reuse it. */
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
/**
 * The error a fetch raises when the CALLER's signal fires, as opposed to a
 * timeout signal. Node names the two differently, which is exactly what lets
 * a deliberate stop be told apart from a wedged socket.
 */
export function isCallerAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * A call the caller stopped. Not a provider failure: it is never retried, and
 * consumers that record failures record it as its own thing (issue #532).
 */
export class ModelGatewayAbortedError extends ModelGatewayError {
  constructor(provider: string, cause?: unknown) {
    super(`${provider} call was stopped by the caller`, false, cause);
    this.name = 'ModelGatewayAbortedError';
  }
}

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
      // Already classified by the adapter (e.g. a local timeout —): respect its retryable flag, never re-wrap.
      if (error instanceof ModelGatewayError) {
        if (error.retryable && attempt < maxRetries) {
          await sleep(baseMs * 2 ** attempt);
          continue;
        }
        throw error;
      }
      // A CALLER abort is fatal, never retried (issue #532). An abort carries
      // no HTTP status, and a status-less failure is classified retryable, so
      // without this a user pressing Stop would retry the very call they just
      // stopped: generated again, billed again. The unsignalled ceiling and
      // the per-tier timeouts raise `TimeoutError`, not `AbortError`, so they
      // keep the retry behaviour issue #496 gave them.
      if (isCallerAbort(error)) throw new ModelGatewayAbortedError(provider, error);
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

/**
 * The ceiling on any provider call that carries no explicit deadline of its
 * own (issue #496). Hosted calls historically ran with NO timeout, so a
 * single black-holed HTTPS request hung its pipeline job forever: no error,
 * no retry, no dead letter, just a locked job going stale (observed live,
 * twice, on an 88 KB invoice; the network answered a fresh request in
 * 324 ms while the wedged one sat for ten minutes). Ten minutes is generous
 * beyond any legitimate hosted call, and an elapsed ceiling surfaces as an
 * abort with no HTTP status, which the retry policy already classifies as
 * RETRYABLE, so a wedged socket becomes an ordinary retried failure.
 * Explicit signals (the self-hosted per-tier timeouts, probe deadlines)
 * still win.
 */
export const UNSIGNALLED_CALL_CEILING_MS = 600_000;

/**
 * A caller's signal ANDed with the ceiling, never instead of it (issue #532).
 * Chat's Stop passes a signal so the provider call actually ends; before this
 * existed, passing one would have silently removed the wedged-socket guard
 * that turns a dead connection into an ordinary retried failure.
 */
function withCeiling(signal?: AbortSignal): AbortSignal {
  const ceiling = AbortSignal.timeout(UNSIGNALLED_CALL_CEILING_MS);
  return signal ? AbortSignal.any([signal, ceiling]) : ceiling;
}

/** POST JSON and parse the JSON response; non-2xx throws a ProviderHttpError. */
export async function postJson<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: withCeiling(signal),
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
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: withCeiling(signal),
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
 * The ONE structured-output contract: parse the
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
