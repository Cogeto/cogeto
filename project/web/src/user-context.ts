import { useQuery } from '@tanstack/react-query';
import type { PreferredLanguage } from '@cogeto/shared';
import { fetchUserContext } from './api';
import type { Session } from './auth/oidc';

/**
 * The per-user instance context, session-available (P6.6, decision 0052).
 * `usePreferredLanguage` is deliberately the future key for UI
 * internationalisation: the UI remains English for now, but any surface can
 * already read the user's language from here, so translation can hang off it
 * later without a second plumbing pass.
 */
export function useUserContext(session: Session) {
  return useQuery({
    queryKey: ['user-context'],
    queryFn: () => fetchUserContext(session),
    staleTime: 60_000,
  });
}

export function usePreferredLanguage(session: Session): PreferredLanguage {
  const context = useUserContext(session);
  return context.data?.preferredLanguage ?? 'en';
}
