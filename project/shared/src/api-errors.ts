/**
 * The contract for a failure a PERSON reads (F13).
 *
 * The server answers a failed request with its usual Nest body and, when the
 * failure is one a user can cause and understand, two extra fields:
 *
 * ```json
 * { "statusCode": 404, "error": "Not Found",
 *   "message": "memory 7f3c not found",
 *   "code": "memory.notFound", "params": { "id": "7f3c" } }
 * ```
 *
 * `code` is a STABLE identifier the interface maps to a key in its own
 * `serverErrors` namespace; `params` are the interpolation values that key's
 * translation places wherever its own word order puts them. `message` stays
 * English and stays exactly what it was: it is the log line, the API answer for
 * a client that is not our SPA, and the fallback the interface renders when it
 * holds no key for the code.
 *
 * Why a code and not a translated message. Three reasons decided the choice,
 * all of them visible in this codebase:
 *
 *  1. Most of these exceptions are thrown from stores and services that have no
 *     `Principal` in scope (`memory.store.ts`, `import.service.ts`,
 *     `provider-config.service.ts`), so producing text in the requester's
 *     language would mean threading a locale through several hundred call
 *     sites. A code needs nothing threaded.
 *  2. The server's language stays independent of the client's. The same
 *     instance answers a Croatian SPA, an English operator script and a
 *     machine client from one code path.
 *  3. The interface can phrase an error to suit the surface it appears on. A
 *     code survives that; a finished sentence does not.
 *
 * The cost, stated plainly: the English sentence now exists twice, at the throw
 * site and in `project/web/src/locales/en/serverErrors.json`. That duplication
 * is not policed by convention, it is policed by `npm run i18n:check`, which
 * reads both and fails the build when they differ by a byte.
 */

/** The interpolation values a coded message places into its translation. */
export type ApiErrorParams = Record<string, string | number>;

/** The SPA namespace holding one key per error code. */
export const API_ERROR_NAMESPACE = 'serverErrors';

/** A failure response, after parsing. `code` is absent for uncoded failures. */
export interface ApiErrorPayload {
  code?: string;
  params?: ApiErrorParams;
  message?: string;
}

function readParams(value: unknown): ApiErrorParams | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const params: ApiErrorParams = {};
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || typeof raw === 'number') params[name] = raw;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * Read a failure body into its parts, tolerating every shape the server can
 * produce: a coded body, Nest's default `{ statusCode, message, error }`, a
 * `message` array from a validation pipe, and anything unrecognised.
 */
export function readApiErrorPayload(body: unknown): ApiErrorPayload {
  if (body === null || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  const raw = record.message;
  const message = Array.isArray(raw)
    ? raw.filter((part): part is string => typeof part === 'string').join('; ')
    : typeof raw === 'string'
      ? raw
      : undefined;
  return {
    code: typeof record.code === 'string' && record.code !== '' ? record.code : undefined,
    params: readParams(record.params),
    message: message !== '' ? message : undefined,
  };
}
