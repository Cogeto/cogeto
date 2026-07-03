import type {
  ChatMessageDto,
  ChatStreamEvent,
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
export const fetchMemory = (session: Session, id: string): Promise<MemoryListItem> =>
  apiGet(`/api/memories/${id}`, session);

export const fetchChatMessages = (session: Session): Promise<ChatMessageDto[]> =>
  apiGet('/api/chat/messages', session);

/**
 * POST /api/chat streams server-sent events (sources → token* → done).
 * EventSource cannot POST or send a bearer token, so this parses the SSE
 * frames off a fetch body stream and hands each event to the caller.
 */
export async function askChat(
  session: Session,
  content: string,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  if (!response.ok || !response.body) throw new Error(`/api/chat -> HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine) onEvent(JSON.parse(dataLine.slice(6)) as ChatStreamEvent);
      boundary = buffer.indexOf('\n\n');
    }
  }
}
