import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PreferredLanguage } from '@cogeto/shared';
import { fetchUserContext } from '../api';
import type { Session } from '../auth/oidc';
import { activeLocale, applyLanguage, browserLocale } from './index';

/**
 * Resolve and apply the interface language (V2.0 item 3.5, Issue A point 1).
 *
 * Precedence, highest first:
 *
 *   1. the user's stored `preferred_language` setting,
 *   2. the browser's preference, narrowed to a locale Cogeto ships,
 *   3. English.
 *
 * (2) applies only while (1) is unknown: signed out, or the context request
 * still in flight. Nothing detects and overrides an explicit choice afterwards.
 *
 * Saving a new language in Settings invalidates the `['user-context']` query,
 * this effect sees the new value, loads the bundle and calls `changeLanguage`.
 * No page reload, no remount: react-i18next re-renders every subscriber.
 */
export function useInterfaceLanguage(session: Session | null): PreferredLanguage {
  const context = useQuery({
    queryKey: ['user-context'],
    queryFn: () => fetchUserContext(session!),
    staleTime: 60_000,
    enabled: session !== null,
  });

  const desired = context.data?.preferredLanguage ?? browserLocale();

  useEffect(() => {
    void applyLanguage(desired);
  }, [desired]);

  return desired;
}

/**
 * The locale the interface is CURRENTLY rendering in, for the formatting
 * helpers at call sites that need it explicitly. Subscribes to i18next through
 * `useTranslation`, so a component using it re-renders on a language change.
 */
export function useActiveLocale(): PreferredLanguage {
  useTranslation();
  return activeLocale();
}
