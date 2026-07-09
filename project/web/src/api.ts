import type {
  ApprovalDecision,
  ApprovalDto,
  AuditPage,
  AuditQuery,
  UserSettingsDto,
  UpdateUserSettingsRequest,
  ChatMessageDto,
  ChatStreamEvent,
  ContradictionDto,
  DeadLetterJobDto,
  ChainVerificationDto,
  DeletionPreviewDto,
  DeletionRequestedDto,
  DreamDigestDto,
  FileDownloadDto,
  FileSourceDto,
  FileStatusDto,
  FileUploadedDto,
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
  WorkerActivityDto,
  ReceiptDetailDto,
  ReceiptListItem,
  ResolveContradictionRequest,
  TaskCountDto,
  TaskDto,
  TaskStatus,
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

async function apiSend<T>(
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
  session: Session,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await toError(path, response);
  return (await response.json()) as T;
}
const apiPost = <T>(path: string, body: unknown, session: Session): Promise<T> =>
  apiSend('POST', path, body, session);
const apiPut = <T>(path: string, body: unknown, session: Session): Promise<T> =>
  apiSend('PUT', path, body, session);

export const fetchMe = (session: Session): Promise<Principal> => apiGet('/api/me', session);
export const fetchHealth = (): Promise<HealthReport> => apiGet('/api/health');

export const captureNote = (session: Session, content: string): Promise<NoteCaptured> =>
  apiPost('/api/notes', { content }, session);
export const fetchNote = (session: Session, id: string): Promise<NoteDto> =>
  apiGet(`/api/notes/${id}`, session);
export const fetchNoteStatus = (session: Session, id: string): Promise<NoteStatusDto> =>
  apiGet(`/api/notes/${id}/status`, session);

// File uploads (O1): the object key is the source id (1:1). Multipart POST —
// the browser sets the multipart boundary, so no content-type header here.
export async function uploadFile(
  session: Session,
  file: File,
  flags: { scope: MemoryScope; sensitive: boolean; discard: boolean },
): Promise<FileUploadedDto> {
  const form = new FormData();
  form.append('file', file);
  form.append('scope', flags.scope);
  form.append('sensitive', String(flags.sensitive));
  form.append('discard', String(flags.discard));
  const response = await fetch('/api/files', {
    method: 'POST',
    headers: { authorization: `Bearer ${session.accessToken}` },
    body: form,
  });
  if (!response.ok) throw await toError('/api/files', response);
  return (await response.json()) as FileUploadedDto;
}

const fileKey = (objectKey: string) => encodeURIComponent(objectKey);
export const fetchFileStatus = (session: Session, objectKey: string): Promise<FileStatusDto> =>
  apiGet(`/api/files/${fileKey(objectKey)}/status`, session);
export const fetchFileSource = (session: Session, objectKey: string): Promise<FileSourceDto> =>
  apiGet(`/api/files/${fileKey(objectKey)}`, session);
export const fetchFileDownload = (session: Session, objectKey: string): Promise<FileDownloadDto> =>
  apiGet(`/api/files/${fileKey(objectKey)}/download`, session);
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

// The plain dreaming digest (§B.6 v1 form, F2-B): the latest finished run's
// actions as at most six linked lines; empty lines = render nothing.
export const fetchDreamDigest = (session: Session): Promise<DreamDigestDto> =>
  apiGet('/api/dreaming/latest', session);

// The Tasks surface (O2-A, decision 0013; F3 handoff §4). Views map to status
// filters; the remaining filters (due window, dormant-only, from_uncertain)
// refine client-side over the capped list.
export const fetchTasks = (
  session: Session,
  params: { status?: TaskStatus; includeSettled?: boolean; entity?: string } = {},
): Promise<TaskDto[]> => {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.includeSettled) search.set('includeSettled', 'true');
  if (params.entity?.trim()) search.set('entity', params.entity.trim());
  const qs = search.toString();
  return apiGet(`/api/tasks${qs ? `?${qs}` : ''}`, session);
};
// The nav badge: open + blocked, owner-scoped (F3 handoff §4).
export const fetchTaskCount = (session: Session): Promise<TaskCountDto> =>
  apiGet('/api/tasks/count', session);
export const taskOperation = (
  session: Session,
  id: string,
  op: 'reopen' | 'dismiss' | 'complete',
): Promise<TaskDto> => apiPost(`/api/tasks/${id}/${op}`, {}, session);

// The contradicted queue (F2-A, decision 0010): open contradictions where both
// facts belong to the caller, and the three owner resolutions.
export const fetchContradictions = (session: Session): Promise<ContradictionDto[]> =>
  apiGet('/api/relations', session);
export const resolveContradiction = (
  session: Session,
  relationId: string,
  body: ResolveContradictionRequest,
): Promise<{ resolved: boolean }> => apiPost(`/api/relations/${relationId}/resolve`, body, session);

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
export const fetchWorkerActivity = (session: Session): Promise<WorkerActivityDto> =>
  apiGet('/api/jobs/activity', session);

// Per-user capture/upload defaults (§A.9, O1-C Settings).
export const fetchSettings = (session: Session): Promise<UserSettingsDto> =>
  apiGet('/api/settings', session);
export const updateSettings = (
  session: Session,
  patch: UpdateUserSettingsRequest,
): Promise<UserSettingsDto> => apiPut('/api/settings', patch, session);

// The read-only audit trail (§A.8/§B.1, O1-C).
export function fetchAudit(session: Session, params: AuditQuery = {}): Promise<AuditPage> {
  const search = new URLSearchParams();
  if (params.actor?.trim()) search.set('actor', params.actor.trim());
  if (params.action?.trim()) search.set('action', params.action.trim());
  if (params.entityType?.trim()) search.set('entityType', params.entityType.trim());
  if (params.from) search.set('from', params.from);
  if (params.to) search.set('to', params.to);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.offset !== undefined) search.set('offset', String(params.offset));
  const qs = search.toString();
  return apiGet(`/api/audit${qs ? `?${qs}` : ''}`, session);
}

// The approval state machine (§A.8, O1-B). Create → confirm (approve|reject) is
// the ONLY path; execution happens server-side in the worker.
export const fetchPendingApprovals = (session: Session): Promise<ApprovalDto[]> =>
  apiGet('/api/approvals', session);
export const fetchApprovalHistory = (session: Session): Promise<ApprovalDto[]> =>
  apiGet('/api/approvals/history', session);
export const createApproval = (
  session: Session,
  actionType: string,
  payload: unknown,
): Promise<ApprovalDto> => apiPost('/api/approvals', { actionType, payload }, session);
export const confirmApproval = (
  session: Session,
  id: string,
  decision: ApprovalDecision,
): Promise<ApprovalDto> => apiPost(`/api/approvals/${id}`, { decision }, session);
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
