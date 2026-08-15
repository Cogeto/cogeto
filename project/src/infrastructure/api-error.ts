import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ApiErrorParams } from '@cogeto/shared';

/**
 * Every HTTP failure this server raises is built here (F13).
 *
 * There are exactly two kinds, and the throw site declares which:
 *
 * ```ts
 * throw userError.notFound('memory.notFound', 'memory {{id}} not found', { id });
 * throw untranslatedError.badRequest(`unknown action type '${actionType}'`);
 * ```
 *
 * ## Which one
 *
 * The question is not "is this an error" but **"will a person read this
 * sentence, and can we write it for them?"**
 *
 * Use `userError` when a person using the interface can cause the failure and
 * would act on the answer: a name left blank, a file too large, a state that
 * forbids the action, a limit reached, a thing that is gone. These carry a
 * `code`, and the interface renders its own translation of that code.
 *
 * Use `untranslatedError` in exactly three situations, and no others:
 *
 *  1. **A developer error.** The failure means our own code is wrong, or a
 *     request arrived in a shape our own interface never sends. Nobody but an
 *     engineer benefits from the words, and a translation would dress up a bug
 *     as an ordinary answer.
 *  2. **A machine client.** Nothing renders the body: the mail intake token
 *     guard, the health-endpoint token guard, a webhook signature. There is no
 *     person and no locale.
 *  3. **Text we did not write.** The sentence is a model provider's own error
 *     or a validation library's own message, passed through verbatim. There is
 *     nothing to translate; the interface shows it as the detail it is.
 *
 * When it is genuinely both (a user-facing failure whose detail is upstream
 * text), the code goes on the frame and the upstream words travel as a
 * parameter.
 *
 * ## Why the English stays here
 *
 * The template stays at the throw site because it is the log line and the
 * answer to a client that is not our SPA, and because moving 200 sentences into
 * a catalogue would have made every one of these call sites unreadable. It is
 * duplicated in `project/web/src/locales/en/serverErrors.json`, and
 * `npm run i18n:check` reads both and fails the build on a byte of difference,
 * on an unknown code, and on a code no key covers.
 *
 * ## Interpolation, not assembly
 *
 * A value inside a message is `{{named}}`, never a template literal:
 * `'memory {{id}} not found'`, not `` `memory ${id} not found` ``. Croatian and
 * German put those values in different places in the sentence, and a value
 * baked into the string cannot move. The scanner enforces the rule by refusing
 * a `userError` template that contains `${`.
 */

/** `{{name}}` -> the named value, so `message` reads as a finished sentence. */
function interpolate(template: string, params?: ApiErrorParams): string {
  if (!params) return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** Nest's own reason phrase, so the body keeps the shape clients already parse. */
function reasonPhrase(status: HttpStatus): string {
  const name = HttpStatus[status] ?? 'ERROR';
  return name
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

type ExceptionFactory = new (body: Record<string, unknown>) => HttpException;

/** Nest ships no 429 class; the durable limits and the daily quotas need one. */
class TooManyRequestsException extends HttpException {
  constructor(responseBody: Record<string, unknown>) {
    super(responseBody, HttpStatus.TOO_MANY_REQUESTS);
  }
}

const KINDS = {
  badRequest: [BadRequestException, HttpStatus.BAD_REQUEST],
  unauthorized: [UnauthorizedException, HttpStatus.UNAUTHORIZED],
  forbidden: [ForbiddenException, HttpStatus.FORBIDDEN],
  notFound: [NotFoundException, HttpStatus.NOT_FOUND],
  conflict: [ConflictException, HttpStatus.CONFLICT],
  gone: [GoneException, HttpStatus.GONE],
  tooLarge: [PayloadTooLargeException, HttpStatus.PAYLOAD_TOO_LARGE],
  unprocessable: [UnprocessableEntityException, HttpStatus.UNPROCESSABLE_ENTITY],
  unavailable: [ServiceUnavailableException, HttpStatus.SERVICE_UNAVAILABLE],
  tooManyRequests: [TooManyRequestsException, HttpStatus.TOO_MANY_REQUESTS],
} as const satisfies Record<string, readonly [ExceptionFactory, HttpStatus]>;

export type ApiErrorKind = keyof typeof KINDS;

function body(
  status: HttpStatus,
  message: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  // Additive to Nest's default body: `statusCode`, `message` and `error` keep
  // the values and the spelling they already had, so no existing client breaks.
  return { statusCode: status, message, error: reasonPhrase(status), ...extra };
}

/**
 * A failure a person reads, in their own language.
 *
 * @param code     stable identifier; the interface's `serverErrors` key
 * @param template the English sentence, with `{{named}}` interpolation
 * @param params   the values, placed by each language's own word order
 */
export type UserErrorFactory = (
  code: string,
  template: string | PluralTemplate,
  params?: ApiErrorParams,
  extra?: Record<string, unknown>,
) => HttpException;

/**
 * A message whose grammar depends on a count. The interface renders the
 * locale's own CLDR form; `message` (the log line and the fallback) picks
 * between these two, which is as far as English needs.
 */
export interface PluralTemplate {
  one: string;
  other: string;
}

/** A failure nothing can translate. See the three legitimate reasons above. */
export type UntranslatedErrorFactory = (
  message: string,
  extra?: Record<string, unknown>,
) => HttpException;

function buildUser([Exception, status]: readonly [ExceptionFactory, HttpStatus]): UserErrorFactory {
  return (code, template, params, extra) => {
    const chosen =
      typeof template === 'string' ? template : params?.count === 1 ? template.one : template.other;
    return new Exception(
      body(status, interpolate(chosen, params), {
        ...(extra ?? {}),
        code,
        ...(params && Object.keys(params).length > 0 ? { params } : {}),
      }),
    );
  };
}

function buildUntranslated([Exception, status]: readonly [
  ExceptionFactory,
  HttpStatus,
]): UntranslatedErrorFactory {
  return (message, extra) => new Exception(body(status, message, extra ?? {}));
}

function factories<T>(build: (kind: (typeof KINDS)[ApiErrorKind]) => T): Record<ApiErrorKind, T> {
  const out = {} as Record<ApiErrorKind, T>;
  for (const [name, kind] of Object.entries(KINDS)) {
    out[name as ApiErrorKind] = build(kind);
  }
  return out;
}

/** Coded, translated by the interface. The default for anything a user causes. */
export const userError: Record<ApiErrorKind, UserErrorFactory> = factories(buildUser);

/** Uncoded English. Developer errors, machine clients, and text we did not write. */
export const untranslatedError: Record<ApiErrorKind, UntranslatedErrorFactory> =
  factories(buildUntranslated);
