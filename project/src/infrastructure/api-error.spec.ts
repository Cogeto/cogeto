import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { readApiErrorPayload } from '@cogeto/shared';
import { untranslatedError, userError } from './api-error';

/**
 * The server half of translatable failures (F13).
 *
 * The interface can only translate what the server names. These are the
 * promises the rest of the system is built on:
 *
 *   coded_failure_travels_with_its_code — a user-facing failure carries a
 *     stable code and its interpolation values, so the interface can render
 *     the same failure in the reader's own language.
 *   body_is_additive — `statusCode`, `message` and `error` keep the values
 *     Nest already produced, so no existing client breaks.
 *   values_are_interpolated_not_built — the English `message` is assembled
 *     from `{{named}}` slots, and the SAME values reach the interface
 *     separately, which is the only way a language that puts them in a
 *     different place can.
 *   untranslated_carries_no_code — a developer error or a machine client's
 *     refusal is declared untranslatable and never pretends otherwise.
 */
describe('api-error', () => {
  const bodyOf = (error: HttpException) => error.getResponse() as Record<string, unknown>;

  it('coded_failure_travels_with_its_code', () => {
    const error = userError.notFound('memory.notFound', 'memory {{id}} not found', { id: '7f3c' });
    const payload = readApiErrorPayload(bodyOf(error));
    expect(payload.code).toBe('memory.notFound');
    expect(payload.params).toEqual({ id: '7f3c' });
    expect(payload.message).toBe('memory 7f3c not found');
    expect(error.getStatus()).toBe(404);
  });

  it('body_is_additive', () => {
    const body = bodyOf(userError.conflict('project.nameTaken', 'you already have one'));
    expect(body.statusCode).toBe(409);
    expect(body.error).toBe('Conflict');
    expect(body.message).toBe('you already have one');
    // Nothing else is invented: an uncoded call site sees the same three keys.
    expect(Object.keys(body).sort()).toEqual(['code', 'error', 'message', 'statusCode']);
  });

  it('values_are_interpolated_not_built', () => {
    const error = userError.badRequest(
      'file.exceedsUploadLimit',
      'file exceeds the {{bytes}}-byte upload limit',
      { bytes: 25_000_000 },
    );
    const payload = readApiErrorPayload(bodyOf(error));
    expect(payload.message).toBe('file exceeds the 25000000-byte upload limit');
    // The value is ALSO separate, so German can put it where German puts it.
    expect(payload.params).toEqual({ bytes: 25_000_000 });
  });

  it('picks the English plural form a count needs', () => {
    const template = {
      one: '{{count}} file has not finished uploading',
      other: '{{count}} files have not finished uploading',
    };
    const one = readApiErrorPayload(
      bodyOf(userError.badRequest('import.uploadsUnfinished', template, { count: 1 })),
    );
    const many = readApiErrorPayload(
      bodyOf(userError.badRequest('import.uploadsUnfinished', template, { count: 4 })),
    );
    expect(one.message).toBe('1 file has not finished uploading');
    expect(many.message).toBe('4 files have not finished uploading');
    // Both carry the count, so a locale with more than two forms picks its own.
    expect(one.params).toEqual({ count: 1 });
    expect(many.params).toEqual({ count: 4 });
  });

  it('untranslated_carries_no_code', () => {
    const error = untranslatedError.badRequest("unknown action type 'nope'");
    const payload = readApiErrorPayload(bodyOf(error));
    expect(payload.code).toBeUndefined();
    expect(payload.message).toBe("unknown action type 'nope'");
  });

  it('keeps a field a client already reads beside the code', () => {
    const body = bodyOf(
      userError.tooManyRequests(
        'limit.rateLimited',
        'rate limit reached for {{bucket}}, retry in {{seconds}}s',
        { bucket: 'capture', seconds: 30 },
        { retryAfterSeconds: 30 },
      ),
    );
    expect(body.retryAfterSeconds).toBe(30);
    expect(body.code).toBe('limit.rateLimited');
  });
});

describe('readApiErrorPayload', () => {
  it('reads Nest’s ordinary body, a validation array, and nonsense', () => {
    expect(readApiErrorPayload({ statusCode: 400, message: 'plain' })).toEqual({
      code: undefined,
      params: undefined,
      message: 'plain',
    });
    expect(readApiErrorPayload({ message: ['a', 'b'] }).message).toBe('a; b');
    expect(readApiErrorPayload(null)).toEqual({});
    expect(readApiErrorPayload({ code: '', message: '' })).toEqual({
      code: undefined,
      params: undefined,
      message: undefined,
    });
  });
});
