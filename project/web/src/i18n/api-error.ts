import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { API_ERROR_NAMESPACE } from '@cogeto/shared';
import { ApiError } from '../api';
import { i18next } from './index';

/**
 * The one place a server failure becomes words on a screen (F13).
 *
 * Before this, several dozen call sites rendered `error.message` straight from
 * the response, so a Croatian page showed an English sentence in the middle of
 * itself. Now the server sends a `code`, this resolves it against the
 * `serverErrors` namespace, and the surface renders its own language.
 *
 * ## Degrading, in order
 *
 * 1. **A code we have a key for.** The translation, with `params`
 *    interpolated by the language's own word order and pluralised by its own
 *    CLDR rules.
 * 2. **A code we do NOT have a key for** (an older interface against a newer
 *    server, or a code someone forgot to add): the server's own English
 *    sentence, which is specific and comprehensible, and only then the
 *    caller's `fallback` key. Never the bare code, and never an empty string:
 *    a user who cannot read the language of an error can still act on it,
 *    while `serverErrors.provider.labelTaken` tells them nothing at all.
 * 3. **No code at all** (a failure the server deliberately left untranslated:
 *    a developer error, a model provider's own sentence): the server's own
 *    `message`, exactly as before. It is English, and it is the honest answer;
 *    inventing a translated sentence for text we did not write would be worse.
 * 4. **Nothing at all**: the caller's `fallback` key, or
 *    `errors:server.unexpected`.
 *
 * `fallback` is a key resolved by the caller's own `t`, so a surface passes the
 * relative key it already had to hand: the copy it used to show when the error
 * was not an `Error`.
 */
export function apiErrorMessage(t: TFunction, error: unknown, fallback?: string): string {
  const generic = () => (fallback ? t(fallback) : t('errors:server.unexpected'));

  if (error instanceof ApiError && error.code) {
    const key = `${API_ERROR_NAMESPACE}:${error.code}`;
    // `exists` needs the params too: a plural key has no bare form, only its
    // CLDR categories, so asking without `count` reports it missing.
    if (i18next.exists(key, { ...error.params })) return t(key, { ...error.params });
    return error.message.trim() !== '' ? error.message : generic();
  }
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error;
  return generic();
}

/**
 * The hook form, for a component. Bound to the active language, so the same
 * error re-renders in the new one when a user switches language mid-session.
 *
 * Pass the surface's own `t` and a `fallback` stays the relative key the
 * surface already uses (`'connect.failed'`); omit it and a fallback has to name
 * its namespace. An explicit `serverErrors:` lookup resolves either way.
 */
export function useApiErrorMessage(
  bound?: TFunction,
): (error: unknown, fallback?: string) => string {
  const { t: fallbackT } = useTranslation();
  const t = bound ?? fallbackT;
  return useCallback(
    (error: unknown, fallback?: string) => apiErrorMessage(t, error, fallback),
    [t],
  );
}
