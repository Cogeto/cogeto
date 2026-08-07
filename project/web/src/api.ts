import type {
  ApprovalDecision,
  ApprovalDto,
  AttentionDismissDto,
  AttentionFeedDto,
  AttentionSeenDto,
  AuditPage,
  AuditQuery,
  DashboardStatsDto,
  UserSettingsDto,
  UserContextDto,
  UpdateUserContextRequest,
  ContextSuggestionsDto,
  ContextSuggestionActionRequest,
  ModelConfigDto,
  UpdateUserSettingsRequest,
  AddEmailAllowlistEntryRequest,
  AddExtractionGateRuleRequest,
  EmailAllowlistEntryDto,
  EmailCaptureConfigDto,
  EntityAliasDto,
  ExtractionGateConfigDto,
  ExtractionGateDto,
  ExtractionGateRuleDto,
  SetExtractionGateRequest,
  SetSourceContextRequest,
  SourceCatalogPageDto,
  SourceInspectionDto,
  CitingAnswerDto,
  MemoryChangeDto,
  MemoryRelationDto,
  SourceBadgeFilter,
  UncertaintyReason,
  SourceContextDto,
  EmailReplyDraftView,
  EmailSourceDto,
  ChatAttachmentCreatedDto,
  ChatAttachmentDto,
  ChatContextDto,
  ChatMessagePage,
  ConversationDto,
  ChatRememberedDto,
  ChatStreamEvent,
  ContradictionDto,
  DeadLetterJobDto,
  ChainVerificationDto,
  DeletionPreviewDto,
  DeletionRequestedDto,
  AwaitingCapabilityDto,
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
  NoteDto,
  NoteStatusDto,
  MeDto,
  WorkerActivityDto,
  ReceiptDetailDto,
  ReceiptListItem,
  ResolveContradictionRequest,
  TimelineDto,
  WebSourceDto,
  ResearchRunDto,
  ResearchRunProgressDto,
  ResearchAnswerDto,
  ResearchCaptureResponse,
  ApproveResearchResponse,
  ProposeSkillRunResponse,
  SkillRunDto,
  SkillRunDetailDto,
  PointInTimeDto,
  TimelineDiffDto,
  PassportExportDto,
  PassportDownloadDto,
  VerificationDto,
  FolderManifestRequest,
  ImportItemDto,
  ImportRunDetailDto,
  ImportRunDto,
  S3ManifestRequest,
  SourceRevisionDto,
} from '@cogeto/shared';
import type { Session } from './auth/oidc';

/** Fired on any 401 so the shell can drop the dead session and re-fetch config. */
export const UNAUTHORIZED_EVENT = 'cogeto:unauthorized';

/** Typed API errors: the server's message (e.g. an illegal transition) is the UI copy. */
async function toError(path: string, response: Response): Promise<Error> {
  // A 401 means the bearer token expired or was revoked (10s Principal-cache
  // bound). Signal the shell exactly once, from the single place
  // every request funnels its failures through, so it can re-derive auth from a
  // fresh /api/config. 403 (e.g. a missing admin role) is NOT this.
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
/** Authenticated: /api/health stopped being public (audit 2.0 SEC-3). Callers
 * without the admin role get the same verdicts with the operational detail
 * trimmed, which is exactly what the status panel renders. */
export const fetchHealth = (session: Session): Promise<HealthReport> =>
  apiGet('/api/health', session);

// The standalone note field left the Memories tab with V2.2 item 5.1 (notes
// are captured through chat's "remember this"), so the SPA no longer calls
// POST /api/notes — the endpoint itself stays, an API entry path unchanged.
export const fetchNote = (session: Session, id: string): Promise<NoteDto> =>
  apiGet(`/api/notes/${id}`, session);

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
/**
 * Read a source again (V2.1 item 4.1): what turns "vision is now configured"
 * into "and everything it could not read before has been read".
 */
export const reprocessSource = (
  session: Session,
  objectKey: string,
): Promise<{ queued: boolean }> =>
  apiPost(`/api/files/${fileKey(objectKey)}/reprocess`, {}, session);
/** Sources this owner has that are waiting for a capability to arrive. */
export const fetchAwaitingCapability = (session: Session): Promise<AwaitingCapabilityDto[]> =>
  apiGet('/api/files/awaiting-capability', session);
// The dashboard is the owner's governance surface: explicit sensitive opt-in
// — the store still returns only the owner's own rows.
export interface MemoryListParams {
  q?: string;
  scope?: MemoryScope;
  status?: MemoryStatus;
  sensitiveOnly?: boolean;
  entity?: string;
  /** The admission taxonomy arm (V2.2 item 5.2). */
  uncertaintyReason?: UncertaintyReason;
  /** Owner-only: the Review queue reviews your own facts, not peers'. */
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
  if (params.uncertaintyReason) search.set('uncertaintyReason', params.uncertaintyReason);
  if (params.mine) search.set('mine', 'true');
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.offset !== undefined) search.set('offset', String(params.offset));
  return apiGet(`/api/memories?${search.toString()}`, session);
}

// The Sources surface (V2.2 item 5.2): the catalog (level one), the
// inspection (level two), and the fact detail's relations + citing answers.
export function fetchSourceCatalog(
  session: Session,
  params: {
    type?: string;
    badge?: SourceBadgeFilter;
    q?: string;
    order?: 'asc' | 'desc';
    cursor?: string;
    limit?: number;
  } = {},
): Promise<SourceCatalogPageDto> {
  const search = new URLSearchParams();
  if (params.type) search.set('type', params.type);
  if (params.badge) search.set('badge', params.badge);
  if (params.q?.trim()) search.set('q', params.q.trim());
  if (params.order) search.set('order', params.order);
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  const qs = search.toString();
  return apiGet(`/api/source-catalog${qs ? `?${qs}` : ''}`, session);
}
export const fetchSourceInspection = (
  session: Session,
  sourceType: string,
  sourceId: string,
): Promise<SourceInspectionDto> =>
  apiGet(`/api/source-catalog/${sourceType}/${encodeURIComponent(sourceId)}`, session);
// Bulk import (V2.2 item 5.3): manifest first, confirm explicitly, watch
// honestly, keep the record. S3 credentials travel in request bodies only and
// are never stored by the server.
export async function createZipImport(session: Session, file: File): Promise<ImportRunDetailDto> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch('/api/imports/zip', {
    method: 'POST',
    headers: { authorization: `Bearer ${session.accessToken}` },
    body: form,
  });
  if (!response.ok) throw await toError('/api/imports/zip', response);
  return (await response.json()) as ImportRunDetailDto;
}
export const createFolderImport = (
  session: Session,
  request: FolderManifestRequest,
): Promise<ImportRunDetailDto> => apiPost('/api/imports/folder', request, session);
export const createS3Import = (
  session: Session,
  request: S3ManifestRequest,
): Promise<ImportRunDetailDto> => apiPost('/api/imports/s3', request, session);
export async function stageImportItem(
  session: Session,
  runId: string,
  itemId: string,
  file: File,
): Promise<ImportItemDto> {
  const form = new FormData();
  form.append('file', file);
  const path = `/api/imports/${runId}/items/${itemId}/file`;
  const response = await fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.accessToken}` },
    body: form,
  });
  if (!response.ok) throw await toError(path, response);
  return (await response.json()) as ImportItemDto;
}
export const excludeImportItems = (
  session: Session,
  runId: string,
  itemIds: string[],
): Promise<ImportRunDetailDto> => apiPost(`/api/imports/${runId}/exclude`, { itemIds }, session);
export const confirmImport = (
  session: Session,
  runId: string,
  s3?: S3ManifestRequest,
): Promise<ImportRunDto> => apiPost(`/api/imports/${runId}/confirm`, s3 ? { s3 } : {}, session);
export const cancelImport = (session: Session, runId: string): Promise<ImportRunDto> =>
  apiPost(`/api/imports/${runId}/cancel`, {}, session);
export const fetchImports = (session: Session): Promise<ImportRunDto[]> =>
  apiGet('/api/imports', session);
export const fetchImportDetail = (session: Session, runId: string): Promise<ImportRunDetailDto> =>
  apiGet(`/api/imports/${runId}`, session);

// Revision links (V2.2 item 5.3): read on the inspection, decided here.
export const confirmSourceRevision = (session: Session, id: string): Promise<SourceRevisionDto> =>
  apiPost(`/api/source-revisions/${id}/confirm`, {}, session);
export const rejectSourceRevision = (session: Session, id: string): Promise<SourceRevisionDto> =>
  apiPost(`/api/source-revisions/${id}/reject`, {}, session);
export const linkSourceRevision = (
  session: Session,
  successor: { sourceType: string; sourceId: string },
  predecessor: { sourceType: string; sourceId: string },
): Promise<SourceRevisionDto> =>
  apiPost('/api/source-revisions/link', { successor, predecessor }, session);

export const fetchMemoryRelations = (session: Session, id: string): Promise<MemoryRelationDto[]> =>
  apiGet(`/api/relations/for-memory/${id}`, session);
export const fetchCitingAnswers = (session: Session, id: string): Promise<CitingAnswerDto[]> =>
  apiGet(`/api/chat/citing/${id}`, session);
export const fetchMemoryChanges = (
  session: Session,
  since: string,
  limit = 100,
): Promise<MemoryChangeDto[]> =>
  apiGet(`/api/memories/changes?since=${encodeURIComponent(since)}&limit=${limit}`, session);

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

// The attention surface: the computed "what needs me now"
// feed + honest unread state; viewing clears it; digest lines are dismissible.
export const fetchAttention = (session: Session): Promise<AttentionFeedDto> =>
  apiGet('/api/attention', session);
export const markAttentionSeen = (session: Session): Promise<AttentionSeenDto> =>
  apiPost('/api/attention/seen', {}, session);
export const dismissAttentionItem = (session: Session, key: string): Promise<AttentionDismissDto> =>
  apiPost('/api/attention/dismiss', { key }, session);

// The dashboard statistics: cheap, gated aggregates + two
// bounded daily series behind the redesigned home screen's visualizations.
export const fetchDashboardStats = (session: Session): Promise<DashboardStatsDto> =>
  apiGet('/api/dashboard/stats', session);

// The contradicted queue: open contradictions where both
// facts belong to the caller, and the three owner resolutions.
export const fetchContradictions = (session: Session): Promise<ContradictionDto[]> =>
  apiGet('/api/relations', session);
export const resolveContradiction = (
  session: Session,
  relationId: string,
  body: ResolveContradictionRequest,
): Promise<{ resolved: boolean }> => apiPost(`/api/relations/${relationId}/resolve`, body, session);

// Source-level true deletion (spec §11.1, spec §11.1): impact preview for the confirm
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

// The Forgotten ledger (spec §11.1) + the sweep's System surface (spec §11.1 step 4).
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

// Entity aliases (V2.3 item 6.1): the recorded equivalences behind
// alias-aware contradiction pairing, managed on the Settings page.
export const fetchEntityAliases = (session: Session): Promise<EntityAliasDto[]> =>
  apiGet('/api/reconcile-aliases', session);
export const addEntityAlias = (
  session: Session,
  request: { canonical: string; alias: string },
): Promise<EntityAliasDto> => apiPost('/api/reconcile-aliases', request, session);
export async function removeEntityAlias(
  session: Session,
  id: string,
): Promise<{ removed: boolean }> {
  const path = `/api/reconcile-aliases/${id}`;
  const response = await fetch(path, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok) throw await toError(path, response);
  return (await response.json()) as { removed: boolean };
}

// Per-user capture/upload defaults (Settings).
export const fetchSettings = (session: Session): Promise<UserSettingsDto> =>
  apiGet('/api/settings', session);
export const updateSettings = (
  session: Session,
  patch: UpdateUserSettingsRequest,
): Promise<UserSettingsDto> => apiPut('/api/settings', patch, session);

// Model configuration: read-only display of the active
// provider configuration. Keys are operator-set and never pass through here.
export const fetchModelConfig = (session: Session): Promise<ModelConfigDto> =>
  apiGet('/api/settings/model-config', session);

// Instance context + language (-0053).
export const fetchUserContext = (session: Session): Promise<UserContextDto> =>
  apiGet('/api/settings/context', session);
export const updateUserContext = (
  session: Session,
  patch: UpdateUserContextRequest,
): Promise<UserContextDto> => apiPut('/api/settings/context', patch, session);
export const fetchContextSuggestions = (session: Session): Promise<ContextSuggestionsDto> =>
  apiGet('/api/settings/context/suggestions', session);
export const acceptContextSuggestion = (
  session: Session,
  request: ContextSuggestionActionRequest,
): Promise<UserContextDto> => apiPost('/api/settings/context/suggestions/accept', request, session);
export const dismissContextSuggestion = (
  session: Session,
  request: ContextSuggestionActionRequest,
): Promise<{ dismissed: true }> =>
  apiPost('/api/settings/context/suggestions/dismiss', request, session);

// Email capture: the inbound address, the sender allowlist, and
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

// The extraction gate (V2.1 item 4.3): per-connector admission control over
// extraction — enable, budget, retention, rules — plus the recent refusals.
export const fetchExtractionGateConfig = (session: Session): Promise<ExtractionGateConfigDto> =>
  apiGet('/api/extraction-gate', session);
export const setExtractionGate = (
  session: Session,
  sourceType: string,
  patch: SetExtractionGateRequest,
): Promise<ExtractionGateDto> =>
  apiPut(`/api/extraction-gate/${encodeURIComponent(sourceType)}`, patch, session);
export const addExtractionGateRule = (
  session: Session,
  request: AddExtractionGateRuleRequest,
): Promise<ExtractionGateRuleDto> => apiPost('/api/extraction-gate/rules', request, session);
// The anchoring context (V2.1 item 4.2): what a document is about, editable;
// re-anchoring is the existing reprocess action.
export const fetchSourceContext = (
  session: Session,
  sourceType: string,
  sourceId: string,
): Promise<SourceContextDto> =>
  apiGet(
    `/api/source-context/${encodeURIComponent(sourceType)}/${encodeURIComponent(sourceId)}`,
    session,
  );
export const setSourceContext = (
  session: Session,
  sourceType: string,
  sourceId: string,
  request: SetSourceContextRequest,
): Promise<SourceContextDto> =>
  apiPut(
    `/api/source-context/${encodeURIComponent(sourceType)}/${encodeURIComponent(sourceId)}`,
    request,
    session,
  );

export async function removeExtractionGateRule(session: Session, id: string): Promise<void> {
  const path = `/api/extraction-gate/rules/${encodeURIComponent(id)}`;
  const response = await fetch(path, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok) throw await toError(path, response);
}

// The read-only audit trail (/spec §11.1).
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

// The approval state machine. Create → confirm (approve|reject) is
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

// The email reading view behind an email memory's source drawer.
export const fetchEmailSource = (session: Session, emailId: string): Promise<EmailSourceDto> =>
  apiGet(`/api/email/${encodeURIComponent(emailId)}/source`, session);

// The retained web page behind a web memory's source drawer.
export const fetchWebSource = (session: Session, id: string): Promise<WebSourceDto> =>
  apiGet(`/api/research/${encodeURIComponent(id)}/source`, session);

// Research runs (Part B): propose → show-edit-approve gate → capture → synthesis.
// `conversationId`: the invoking chat thread — the concluded
// answer is appended there automatically.
export const proposeResearch = (
  session: Session,
  intent: string,
  conversationId?: string,
): Promise<ResearchRunDto> =>
  apiPost(
    '/api/research/propose',
    conversationId ? { intent, conversationId } : { intent },
    session,
  );
export const fetchResearchRuns = (session: Session): Promise<ResearchRunDto[]> =>
  apiGet('/api/research/runs', session);
export const fetchResearchRun = (session: Session, id: string): Promise<ResearchRunDto> =>
  apiGet(`/api/research/runs/${encodeURIComponent(id)}`, session);
// The in-chat flow's honest wait: per-page pipeline progress.
export const fetchResearchProgress = (
  session: Session,
  id: string,
): Promise<ResearchRunProgressDto> =>
  apiGet(`/api/research/runs/${encodeURIComponent(id)}/progress`, session);
export const approveResearch = (
  session: Session,
  id: string,
  query: string,
): Promise<ApproveResearchResponse> =>
  apiPost(`/api/research/runs/${encodeURIComponent(id)}/approve`, { query }, session);
export const cancelResearch = (session: Session, id: string): Promise<ResearchRunDto> =>
  apiPost(`/api/research/runs/${encodeURIComponent(id)}/cancel`, {}, session);
export const captureResearchPages = (
  session: Session,
  id: string,
  urls: string[],
): Promise<ResearchCaptureResponse> =>
  apiPost(`/api/research/runs/${encodeURIComponent(id)}/capture`, { urls }, session);
export const synthesiseResearch = (session: Session, id: string): Promise<ResearchAnswerDto> =>
  apiPost(`/api/research/runs/${encodeURIComponent(id)}/synthesise`, {}, session);
// The stored answer was seen: the chat resume surface stops
// showing this run.
export const markResearchSeen = (session: Session, id: string): Promise<{ ok: true }> =>
  apiPost(`/api/research/runs/${encodeURIComponent(id)}/seen`, {}, session);

// Named skills: propose → the plan gate → the
// live run view → the brief.
export const proposeSkillRun = (
  session: Session,
  skillId: string,
  subject: string,
): Promise<ProposeSkillRunResponse> => apiPost('/api/skills/runs', { skillId, subject }, session);
export const fetchSkillRuns = (session: Session): Promise<SkillRunDto[]> =>
  apiGet('/api/skills/runs', session);
export const fetchSkillRun = (session: Session, id: string): Promise<SkillRunDetailDto> =>
  apiGet(`/api/skills/runs/${encodeURIComponent(id)}`, session);
export const approveSkillPlan = (
  session: Session,
  id: string,
  queries: { researchRunId: string; query: string }[],
): Promise<SkillRunDetailDto> =>
  apiPost(`/api/skills/runs/${encodeURIComponent(id)}/plan`, { queries }, session);
export const cancelSkillRun = (session: Session, id: string): Promise<SkillRunDetailDto> =>
  apiPost(`/api/skills/runs/${encodeURIComponent(id)}/cancel`, {}, session);
// Reply drafts. Drafting is a consequential action;
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

// Time-travel: the visual surface over the temporal primitives.
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

// Memory Passport (spec §11.4): a complete, documented, versioned export of the
// user's own data. Trigger → poll → download via a short-lived signed URL.
export const triggerPassportExport = (
  session: Session,
  includeOriginals: boolean,
): Promise<PassportExportDto> => apiPost('/api/passport/exports', { includeOriginals }, session);
export const fetchPassportExports = (session: Session): Promise<PassportExportDto[]> =>
  apiGet('/api/passport/exports', session);
export const fetchPassportDownload = (session: Session, id: string): Promise<PassportDownloadDto> =>
  apiGet(`/api/passport/exports/${id}/download`, session);

// Conversations: the sidebar's containers. Memory is the
// continuity, conversations are workspaces — deleting one is a SOURCE deletion
// (deleteSource with type 'chat_conversation'), never a chat route.
export const fetchConversations = (session: Session): Promise<ConversationDto[]> =>
  apiGet('/api/chat/conversations', session);
export const createConversation = (session: Session): Promise<ConversationDto> =>
  apiPost('/api/chat/conversations', {}, session);
export const renameConversation = (
  session: Session,
  id: string,
  title: string,
): Promise<ConversationDto> => apiPut(`/api/chat/conversations/${id}/title`, { title }, session);
export const setConversationArchived = (
  session: Session,
  id: string,
  archived: boolean,
): Promise<ConversationDto> =>
  apiPut(`/api/chat/conversations/${id}/archived`, { archived }, session);
export const fetchChatMessages = (
  session: Session,
  conversationId: string,
): Promise<ChatMessagePage> =>
  apiGet(`/api/chat/conversations/${conversationId}/messages`, session);

// Chat-derived memory capture: "remember this" on a user
// message routes it through the pipeline (source_type 'chat').
export const rememberChatMessage = (session: Session, id: string): Promise<ChatRememberedDto> =>
  apiPost(`/api/chat/messages/${id}/remember`, {}, session);
export const fetchChatCaptureStatus = (session: Session, id: string): Promise<NoteStatusDto> =>
  apiGet(`/api/chat/messages/${id}/capture-status`, session);
export const fetchChatContext = (session: Session, id: string): Promise<ChatContextDto> =>
  apiGet(`/api/chat/messages/${id}/context`, session);

// Conversation attachments (V2.2 item 5.1): the paperclip's upload (same
// validation and caps as /api/files, one path, two affordances), the card's
// poll, and the conversation's attachment list.
export async function uploadChatAttachment(
  session: Session,
  file: File,
  conversationId: string,
  transient: boolean,
): Promise<ChatAttachmentCreatedDto> {
  const form = new FormData();
  form.append('file', file);
  form.append('conversationId', conversationId);
  form.append('transient', String(transient));
  const response = await fetch('/api/chat/attachments', {
    method: 'POST',
    headers: { authorization: `Bearer ${session.accessToken}` },
    body: form,
  });
  if (!response.ok) throw await toError('/api/chat/attachments', response);
  return (await response.json()) as ChatAttachmentCreatedDto;
}
export const fetchChatAttachment = (session: Session, id: string): Promise<ChatAttachmentDto> =>
  apiGet(`/api/chat/attachments/${id}`, session);
export const fetchConversationAttachments = (
  session: Session,
  conversationId: string,
): Promise<ChatAttachmentDto[]> =>
  apiGet(`/api/chat/conversations/${conversationId}/attachments`, session);

/**
 * POST /api/chat streams server-sent events (sources → token* → done).
 * EventSource cannot POST or send a bearer token, so this parses the SSE
 * frames off a fetch body stream and hands each event to the caller.
 */
export async function askChat(
  session: Session,
  content: string,
  conversationId: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
  options: { thinking?: boolean; attachmentIds?: string[] } = {},
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      content,
      conversationId,
      thinking: options.thinking,
      ...(options.attachmentIds?.length ? { attachmentIds: options.attachmentIds } : {}),
    }),
    // Switching conversations mid-stream detaches cleanly: the message
    // still lands server-side in the conversation it was sent to.
    signal,
  });
  // A 429 (rate limit / too many concurrent streams) arrives BEFORE the
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
