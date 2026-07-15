import type {
  ApprovalDecision,
  ApprovalDto,
  AuditPage,
  AuditQuery,
  UserSettingsDto,
  UpdateUserSettingsRequest,
  AddEmailAllowlistEntryRequest,
  EmailAllowlistEntryDto,
  EmailCaptureConfigDto,
  EmailReplyDraftView,
  EmailSourceDto,
  ChatContextDto,
  ChatMessageDto,
  ChatRememberedDto,
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
  MeDto,
  WorkerActivityDto,
  ReceiptDetailDto,
  ReceiptListItem,
  ResolveContradictionRequest,
  TaskCountDto,
  TaskDto,
  TaskStatus,
  TimelineDto,
  PointInTimeDto,
  TimelineDiffDto,
  PassportExportDto,
  PassportDownloadDto,
  VerificationDto,
} from '@cogeto/shared';
import type { Session } from './auth/oidc';

/** Fired on any 401 so the shell can drop the dead session and re-fetch config (QS-36). */
export const UNAUTHORIZED_EVENT = 'cogeto:unauthorized';

/** Typed API errors: the server's message (e.g. an illegal transition) is the UI copy. */
async function toError(path: string, response: Response): Promise<Error> {
  // A 401 means the bearer token expired or was revoked (10s Principal-cache
  // bound, decision 0026). Signal the shell exactly once, from the single place
  // every request funnels its failures through, so it can re-derive auth from a
  // fresh /api/config (QS-36). 403 (e.g. a missing admin role) is NOT this.
  if (response.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
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

export const fetchMe = (session: Session): Promise<MeDto> => apiGet('/api/me', session);
export const fetchHealth = (): Promise<HealthReport> => apiGet('/api/health');

export const captureNote = (
  session: Session,
  content: string,
  scope?: MemoryScope,
): Promise<NoteCaptured> => apiPost('/api/notes', { content, scope }, session);
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
  /** Owner-only (O2-B): the Review queue reviews your own facts, not peers'. */
  mine?: boolean;
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
  if (params.mine) search.set('mine', 'true');
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
export const changeMemoryScope = (
  session: Session,
  id: string,
  scope: MemoryScope,
): Promise<MemoryListItem> => apiPost(`/api/memories/${id}/scope`, { scope }, session);
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

// Email capture (Session O4): the inbound address, the sender allowlist, and
// recent refusals for one-click allowlisting.
export const fetchEmailConfig = (session: Session): Promise<EmailCaptureConfigDto> =>
  apiGet('/api/email/config', session);
export const addEmailAllowlistEntry = (
  session: Session,
  request: AddEmailAllowlistEntryRequest,
): Promise<EmailAllowlistEntryDto> => apiPost('/api/email/allowlist', request, session);
export async function removeEmailAllowlistEntry(session: Session, id: string): Promise<void> {
  const path = `/api/email/allowlist/${encodeURIComponent(id)}`;
  const response = await fetch(path, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok) throw await toError(path, response);
}

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

// The email reading view behind an email memory's source drawer (Session O4).
export const fetchEmailSource = (session: Session, emailId: string): Promise<EmailSourceDto> =>
  apiGet(`/api/email/${encodeURIComponent(emailId)}/source`, session);

// Reply drafts (Session O4 — email source). Drafting is a consequential action;
// Cogeto never sends — the finalised draft is presented for the user to send.
export const draftEmailReply = (
  session: Session,
  emailId: string,
  intent?: string,
): Promise<ApprovalDto> =>
  apiPost(
    `/api/email/${encodeURIComponent(emailId)}/reply-draft`,
    intent ? { intent } : {},
    session,
  );
export const fetchEmailDraft = (
  session: Session,
  approvalId: string,
): Promise<EmailReplyDraftView> =>
  apiGet(`/api/approvals/${encodeURIComponent(approvalId)}/email-draft`, session);
export const retryDeadLetterJob = (session: Session, id: string): Promise<{ retried: boolean }> =>
  apiPost(`/api/jobs/dead-letter/${id}/retry`, {}, session);

// Time-travel (decision 0012): the visual surface over the temporal primitives.
// Thin reads — a subject's spans, the subject at an instant, and the diff
// between two instants. Every read is Principal-gated server-side.
export const fetchTimeline = (session: Session, subject: string): Promise<TimelineDto> =>
  apiGet(`/api/timeline?subject=${encodeURIComponent(subject)}`, session);
export const fetchTimelineAt = (
  session: Session,
  subject: string,
  at: string,
): Promise<PointInTimeDto> =>
  apiGet(
    `/api/timeline/at?subject=${encodeURIComponent(subject)}&at=${encodeURIComponent(at)}`,
    session,
  );
export const fetchTimelineDiff = (
  session: Session,
  subject: string,
  from: string,
  to: string,
): Promise<TimelineDiffDto> =>
  apiGet(
    `/api/timeline/diff?subject=${encodeURIComponent(subject)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    session,
  );

// Memory Passport (§B.5): a complete, documented, versioned export of the
// user's own data. Trigger → poll → download via a short-lived signed URL.
export const triggerPassportExport = (
  session: Session,
  includeOriginals: boolean,
): Promise<PassportExportDto> => apiPost('/api/passport/exports', { includeOriginals }, session);
export const fetchPassportExports = (session: Session): Promise<PassportExportDto[]> =>
  apiGet('/api/passport/exports', session);
export const fetchPassportExport = (session: Session, id: string): Promise<PassportExportDto> =>
  apiGet(`/api/passport/exports/${id}`, session);
export const fetchPassportDownload = (session: Session, id: string): Promise<PassportDownloadDto> =>
  apiGet(`/api/passport/exports/${id}/download`, session);

export const fetchChatMessages = (session: Session): Promise<ChatMessageDto[]> =>
  apiGet('/api/chat/messages', session);

// Chat-derived memory capture (O2-C, decision 0021): "remember this" on a user
// message routes it through the pipeline (source_type 'chat').
export const rememberChatMessage = (session: Session, id: string): Promise<ChatRememberedDto> =>
  apiPost(`/api/chat/messages/${id}/remember`, {}, session);
export const fetchChatCaptureStatus = (session: Session, id: string): Promise<NoteStatusDto> =>
  apiGet(`/api/chat/messages/${id}/capture-status`, session);
export const fetchChatContext = (session: Session, id: string): Promise<ChatContextDto> =>
  apiGet(`/api/chat/messages/${id}/context`, session);

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
  // A 429 (rate limit / too many concurrent streams, FIX-2) arrives BEFORE the
  // stream starts — surface the server's message as the UI copy.
  if (!response.ok || !response.body) throw await toError('/api/chat', response);

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
