import type {
  HealthReport,
  MemoryListItem,
  NoteCaptured,
  NoteDto,
  NoteStatusDto,
  Principal,
} from '@cogeto/shared';
import type { Session } from './auth/oidc';

async function apiGet<T>(path: string, session?: Session): Promise<T> {
  const response = await fetch(path, {
    headers: session ? { authorization: `Bearer ${session.accessToken}` } : {},
  });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function apiPost<T>(path: string, body: unknown, session: Session): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return (await response.json()) as T;
}

export const fetchMe = (session: Session): Promise<Principal> => apiGet('/api/me', session);
export const fetchHealth = (): Promise<HealthReport> => apiGet('/api/health');

export const captureNote = (session: Session, content: string): Promise<NoteCaptured> =>
  apiPost('/api/notes', { content }, session);
export const fetchNote = (session: Session, id: string): Promise<NoteDto> =>
  apiGet(`/api/notes/${id}`, session);
export const fetchNoteStatus = (session: Session, id: string): Promise<NoteStatusDto> =>
  apiGet(`/api/notes/${id}/status`, session);
// The dashboard is the owner's governance surface: explicit sensitive opt-in
// (decision 0003 ruling 3) — the store still returns only the owner's own rows.
export const fetchMemories = (session: Session): Promise<MemoryListItem[]> =>
  apiGet('/api/memories?includeSensitive=true', session);
