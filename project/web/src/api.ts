import type { HealthReport, Principal } from '@cogeto/shared';
import type { Session } from './auth/oidc';

async function apiGet<T>(path: string, session?: Session): Promise<T> {
  const response = await fetch(path, {
    headers: session ? { authorization: `Bearer ${session.accessToken}` } : {},
  });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return (await response.json()) as T;
}

export const fetchMe = (session: Session): Promise<Principal> => apiGet('/api/me', session);
export const fetchHealth = (): Promise<HealthReport> => apiGet('/api/health');
