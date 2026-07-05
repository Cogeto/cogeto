import type {
  ChatMessageDto,
  ChatStreamEvent,
  DeadLetterJobDto,
  ChainVerificationDto,
  DeletionPreviewDto,
  DeletionRequestedDto,
  HealthReport,
  IntegrityStatusDto,
  MemoryListItem,
  MemoryPage,
  MemoryScope,
  MemoryStatus,
  NoteCaptured,
  NoteDto,
  NoteStatusDto,
  Principal,
  ReceiptDetailDto,
  ReceiptListItem,
  VerificationDto,
} from '@cogeto/shared';
import type { Session } from './auth/oidc';

/** Typed API errors: the server's message (e.g. an illegal transition) is the UI copy. */
async function toError(path: string, response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { message?: string | string[] };
    const message = Array.isArray(body.message) ? body.message.join('; ') : body.message;
    if (message) return new Error(message);
  } catch {
    // fall through to the generic error
  }
  return new Error(`${path} -> HTTP ${response.status}`);
}

async function apiGet<T>(path: string, session?: Session): Promise<T> {
  const response = await fetch(path, {
    headers: session ? { authorization: `Bearer ${session.accessToken}` } : {},
  });
  if (!response.ok) throw await toError(path, response);
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
  if (!response.ok) throw await toError(path, response);
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
export interface MemoryListParams {
  q?: string;
  scope?: MemoryScope;
  status?: MemoryStatus;
  sensitiveOnly?: boolean;
  entity?: string;
  limit?: number;
  offset?: number;
}

export function fetchMemories(
  session: Session,
  params: MemoryListParams = {},
): Promise<MemoryPage> {
  const search = new URLSearchParams({ includeSensitive: 'true' });
  if (params.q?.trim()) search.set('q', params.q.trim());
  if (params.scope) search.set('scope', params.scope);
  if (params.status) search.set('status', params.status);
  if (params.sensitiveOnly) search.set('sensitive', 'true');
  if (params.entity?.trim()) search.set('entity', params.entity.trim());
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.offset !== undefined) search.set('offset', String(params.offset));
  return apiGet(`/api/memories?${search.toString()}`, session);
}

export const fetchMemory = (session: Session, id: string): Promise<MemoryListItem> =>
  apiGet(`/api/memories/${id}`, session);
export const fetchMemoryChain = (session: Session, id: string): Promise<MemoryListItem[]> =>
  apiGet(`/api/memories/${id}/chain`, session);
export const fetchVerification = (session: Session, id: string): Promise<VerificationDto> =>
  apiGet(`/api/memories/${id}/verification`, session);

export const approveMemory = (session: Session, id: string): Promise<MemoryListItem> =>
  apiPost(`/api/memories/${id}/approve`, {}, session);
export const markMemoryOutdated = (session: Session, id: string): Promise<MemoryListItem> =>
  apiPost(`/api/memories/${id}/mark-outdated`, {}, session);
export const setMemorySensitive = (
  session: Session,
  id: string,
  sensitive: boolean,
): Promise<MemoryListItem> => apiPost(`/api/memories/${id}/sensitive`, { sensitive }, session);
export const editMemory = (
  session: Session,
  id: string,
  content: string,
): Promise<{ predecessor: MemoryListItem; successor: MemoryListItem }> =>
  apiPost(`/api/memories/${id}/edit`, { content }, session);
export const rejectMemory = (session: Session, id: string): Promise<{ rejected: boolean }> =>
  apiPost(`/api/memories/${id}/reject`, {}, session);

// Source-level true deletion (§A.7, §B.1): impact preview for the confirm
// dialog, then the saga. The receipt id identifies the pending receipt the
// worker confirms once Qdrant and MinIO acknowledged.
export const fetchDeletionImpact = (
  session: Session,
  sourceType: string,
  sourceId: string,
): Promise<DeletionPreviewDto> =>
  apiGet(`/api/sources/${sourceType}/${encodeURIComponent(sourceId)}/impact`, session);

export async function deleteSource(
  session: Session,
  sourceType: string,
  sourceId: string,
): Promise<DeletionRequestedDto> {
  const path = `/api/sources/${sourceType}/${encodeURIComponent(sourceId)}`;
  const response = await fetch(path, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok) throw await toError(path, response);
  return (await response.json()) as DeletionRequestedDto;
}

// The Forgotten ledger (§B.1) + the sweep's System surface (§A.7 step 4).
export const fetchReceipts = (session: Session): Promise<ReceiptListItem[]> =>
  apiGet('/api/receipts', session);
export const fetchReceipt = (session: Session, id: string): Promise<ReceiptDetailDto> =>
  apiGet(`/api/receipts/${id}`, session);
export const fetchChainStatus = (session: Session): Promise<ChainVerificationDto> =>
  apiGet('/api/receipts/verify', session);
export const fetchIntegrity = (session: Session): Promise<IntegrityStatusDto> =>
  apiGet('/api/integrity', session);
export const fetchInstancePublicKey = (): Promise<{ algorithm: string; publicKeyPem: string }> =>
  apiGet('/api/instance/public-key');

export const fetchDeadLetterJobs = (session: Session): Promise<DeadLetterJobDto[]> =>
  apiGet('/api/jobs/dead-letter', session);
export const retryDeadLetterJob = (session: Session, id: string): Promise<{ retried: boolean }> =>
  apiPost(`/api/jobs/dead-letter/${id}/retry`, {}, session);

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
