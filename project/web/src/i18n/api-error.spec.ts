import { beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { applyLanguage, i18next, initI18n } from './index';
import { apiErrorMessage } from './api-error';

/**
 * A server failure, read by a person, in their own language (F13).
 *
 * Before this, several dozen surfaces rendered the server's English sentence
 * straight into a translated page. What has to be true now:
 *
 *   every_category_translates    — an error from each user-facing family
 *     (not found, conflict, a limit, an authorisation refusal) surfaces in
 *     Croatian, not English.
 *   word_order_survives          — an interpolated value lands where the
 *     TARGET language puts it, which is the whole reason the value travels
 *     separately from the sentence.
 *   plurals_follow_the_locale    — Croatian picks `_few` for 3, where English
 *     has only one plural form to pick from.
 *   unmapped_degrades            — a code this interface has no key for shows
 *     the server's own sentence, never an empty string and never the code.
 *   uncoded_is_unchanged         — a failure the server declared
 *     untranslatable renders exactly as it always did.
 */
describe('apiErrorMessage', () => {
  beforeAll(async () => {
    initI18n('en');
    await applyLanguage('hr');
  });

  const t = (...args: Parameters<typeof i18next.t>) =>
    i18next.t(...args) as unknown as ReturnType<typeof i18next.t>;

  const hr = (error: unknown, fallback?: string) => apiErrorMessage(t as never, error, fallback);

  const coded = (code: string, message: string, params?: Record<string, string | number>) =>
    new ApiError(message, 400, { code, params });

  it('every_category_translates', async () => {
    const cases: Array<[string, string]> = [
      // not found · conflict · a validation refusal · an authorisation refusal
      ['memory.notFound', 'memory {{id}} not found'],
      ['project.nameTaken', 'you already have a project with that name'],
      ['file.empty', 'the uploaded file is empty'],
      ['auth.invalidCredentials', 'invalid username or password'],
    ];
    const english = new Map<string, string>();
    await applyLanguage('en');
    for (const [code, message] of cases) {
      english.set(code, hr(coded(code, message, { id: 'abc' })));
    }
    await applyLanguage('hr');
    for (const [code, message] of cases) {
      const rendered = hr(coded(code, message, { id: 'abc' }));
      expect(rendered, code).not.toBe(english.get(code));
      expect(rendered, code).not.toContain('serverErrors');
      expect(rendered.trim(), code).not.toBe('');
    }
  });

  it('word_order_survives', () => {
    // Croatian puts the identifier and the verb where Croatian puts them; the
    // only guarantee this can make language-agnostically is that the VALUE
    // survives into the translated sentence.
    const rendered = hr(coded('memory.notFound', 'memory {{id}} not found', { id: '7f3c' }));
    expect(rendered).toContain('7f3c');
    expect(rendered).not.toContain('{{id}}');
  });

  it('plurals_follow_the_locale', () => {
    const forms = [1, 3, 7].map((count) =>
      hr(
        coded('import.uploadsUnfinished', '{{count}} files have not finished uploading', {
          count,
        }),
      ),
    );
    // Croatian has one/few/other; three counts must not all read the same.
    expect(new Set(forms).size).toBeGreaterThan(1);
    expect(forms[0]).toContain('1');
    expect(forms[2]).toContain('7');
  });

  it('unmapped_degrades', () => {
    const future = new ApiError('a newer server said something specific', 400, {
      code: 'something.weAddedLater',
    });
    expect(hr(future)).toBe('a newer server said something specific');

    const silent = new ApiError('', 500, { code: 'something.weAddedLater' });
    expect(hr(silent, 'errors:server.unexpected').trim()).not.toBe('');
    expect(hr(silent)).not.toContain('something.weAddedLater');
  });

  it('uncoded_is_unchanged', () => {
    expect(hr(new ApiError("unknown action type 'nope'", 400))).toBe("unknown action type 'nope'");
    expect(hr(new Error('a client-side failure'))).toBe('a client-side failure');
    expect(hr(undefined, 'errors:server.unexpected').trim()).not.toBe('');
  });
});
