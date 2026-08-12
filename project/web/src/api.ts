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
  EmbeddingRebuildPlanDto,
  EmbeddingRebuildRequest,
  ModelConfigDto,
  ModelConfigurationDto,
  ModelTierName,
  ProviderDto,
  ProviderModelsDto,
  ProviderProbeDto,
  CreateProviderRequest,
  UpdateProviderRequest,
  AssignTierRequest,
  UserAnswerModelDto,
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
  ConversationSearchHitDto,
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
  ConfirmImportRequest,
  ImportRunDto,
  S3ManifestRequest,
  SourceRevisionDto,
  FindingsReportDto,
  ReportDownloadDto,
  ReportDownloadFormat,
  ReportScopeDto,
  ProjectDto,
  ProjectWriteDto,
  ProjectAssignmentKind,
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
  method: 'POST' | 'PUT' | 'PATCH',
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
    /** Only this project's sources (V2.5 item 8.3). */
    projectId?: string;
  } = {},
): Promise<SourceCatalogPageDto> {
  const search = new URLSearchParams();
  if (params.type) search.set('type', params.type);
  if (params.badge) search.set('badge', params.badge);
  if (params.projectId) search.set('projectId', params.projectId);
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
  request: ConfirmImportRequest = {},
): Promise<ImportRunDto> =>
  apiPost(
    `/api/imports/${runId}/confirm`,
    {
      ...(request.s3 ? { s3: request.s3 } : {}),
      scope: request.scope,
      sensitive: request.sensitive,
    },
    session,
  );
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
// provider configuration. Keys never pass through here.
export const fetchModelConfig = (session: Session): Promise<ModelConfigDto> =>
  apiGet('/api/settings/model-config', session);

/**
 * Providers and model assignment (V2.4 item 7.1), admin-only. An API key is
 * WRITE-ONLY across this whole surface: it is sent on create or replace and is
 * never present in any response, so nothing here can render one.
 */
export const fetchProviders = (session: Session): Promise<ProviderDto[]> =>
  apiGet('/api/admin/providers', session);
export const createProvider = (
  session: Session,
  request: CreateProviderRequest,
): Promise<ProviderDto> => apiPost('/api/admin/providers', request, session);
export const updateProvider = (
  session: Session,
  id: string,
  request: UpdateProviderRequest,
): Promise<ProviderDto> => apiSend('PATCH', `/api/admin/providers/${id}`, request, session);
export const probeProvider = (session: Session, id: string): Promise<ProviderProbeDto> =>
  apiPost(`/api/admin/providers/${id}/probe`, {}, session);
export const fetchProviderModels = (session: Session, id: string): Promise<ProviderModelsDto> =>
  apiGet(`/api/admin/providers/${id}/models`, session);
export async function deleteProvider(session: Session, id: string): Promise<void> {
  const path = `/api/admin/providers/${id}`;
  const response = await fetch(path, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok) throw await toError(path, response);
}
export const fetchModelConfiguration = (session: Session): Promise<ModelConfigurationDto> =>
  apiGet('/api/admin/model-configuration', session);
export const assignModelTier = (
  session: Session,
  tier: ModelTierName,
  request: AssignTierRequest,
): Promise<ModelConfigurationDto> =>
  apiPut(`/api/admin/model-configuration/${tier}`, request, session);
export const addAnswerOption = (
  session: Session,
  request: { providerId: string; model: string; label: string },
): Promise<ModelConfigurationDto> =>
  apiPost('/api/admin/model-configuration/answer-options', request, session);
export async function removeAnswerOption(
  session: Session,
  id: string,
): Promise<ModelConfigurationDto> {
  const path = `/api/admin/model-configuration/answer-options/${id}`;
  const response = await fetch(path, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok) throw await toError(path, response);
  return (await response.json()) as ModelConfigurationDto;
}

// The managed embedding rebuild (V2.4 item 7.1 second half). Two-step by
// construction: the plan states what will happen and saves nothing; only the
// explicit rebuild POST begins anything.
export const planEmbeddingsRebuild = (
  session: Session,
  request: EmbeddingRebuildRequest,
): Promise<EmbeddingRebuildPlanDto> =>
  apiPost('/api/admin/model-configuration/embeddings/rebuild-plan', request, session);
export const beginEmbeddingsRebuild = (
  session: Session,
  request: EmbeddingRebuildRequest,
): Promise<ModelConfigurationDto> =>
  apiPost('/api/admin/model-configuration/embeddings/rebuild', request, session);
export const cancelEmbeddingsRebuild = (session: Session): Promise<ModelConfigurationDto> =>
  apiPost('/api/admin/model-configuration/embeddings/rebuild/cancel', {}, session);
export const resumeEmbeddingsRebuild = (session: Session): Promise<ModelConfigurationDto> =>
  apiPost('/api/admin/model-configuration/embeddings/rebuild/resume', {}, session);

// The one model choice a user makes for themselves (V2.4 item 7.1).
export const fetchAnswerModel = (session: Session): Promise<UserAnswerModelDto> =>
  apiGet('/api/settings/answer-model', session);
export const updateAnswerModel = (
  session: Session,
  optionId: string | null,
): Promise<UserAnswerModelDto> => apiPut('/api/settings/answer-model', { optionId }, session);

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

/**
 * The connector fleet (V2.5 item 8.1) and its Confluence door (item 8.2).
 * Credential material travels one way here: it is sent on connect or
 * reconnect and never appears in any response, so nothing in the SPA can
 * render a token. The shapes are local because no other consumer shares them.
 */
export type ConnectorState =
  | 'configured'
  | 'authorised'
  | 'syncing'
  | 'healthy'
  | 'degraded'
  | 'needs_reauth'
  | 'disabled'
  | 'removed';

export interface ConnectorSettingsDto {
  backfillDays?: number;
  backfillItemCap?: number;
  /** The user's EXPLICIT everything; never a default. */
  backfillAll?: boolean;
  dailyItemCap?: number;
  /** Why the sync is currently waiting, when it is (cap, budget, rate). */
  pausedReason?: string | null;
}

export interface ConnectorDto {
  id: string;
  kind: string;
  name: string;
  state: ConnectorState;
  statusReason: string | null;
  lastSyncAt: string | null;
  settings: ConnectorSettingsDto;
  webhookExpiresAt: string | null;
  createdAt: string;
}

export interface ConnectorCredentialDto {
  accountIdentity: string | null;
  scopes: string[] | null;
  expiresAt: string | null;
  lastRefreshedAt: string | null;
  refreshFailed: boolean;
}

export interface ConnectorSubScopeStatsDto {
  /** 'all', or an ISO date meaning "modified since". */
  window: string;
  estimatedItems: number;
  computedAt: string;
}

export interface ConnectorSubScopeDto {
  id: string;
  /** The project everything this scope ingests lands in (V2.5 item 8.3
   * issue C1), or null. Applies to what it ingests NEXT. */
  projectId: string | null;
  key: string;
  label: string;
  selected: boolean;
  itemCap: number | null;
  backfillComplete: boolean;
  attachments: boolean;
  stats: ConnectorSubScopeStatsDto | null;
}

export interface ConnectorSyncCountsDto {
  pages: number;
  fetched: number;
  materialized: number;
  unchangedSkipped: number;
  revisions: number;
  moved: number;
  deletedUpstream: number;
  skippedRestricted: number;
  scopeChangesReported: number;
  erasedSkipped: number;
  failed: number;
  presenceMarkedGone?: number;
  presenceRestored?: number;
}

export interface ConnectorSyncRunDto {
  id: string;
  kind: 'backfill' | 'incremental' | 'webhook' | 'presence';
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  reason: string | null;
  counts: ConnectorSyncCountsDto | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ConnectorDetailDto extends ConnectorDto {
  credential: ConnectorCredentialDto | null;
  subScopes: ConnectorSubScopeDto[];
  syncRuns: ConnectorSyncRunDto[];
}

export type ConfluenceConnectFailure =
  'wrong_site' | 'bad_credentials' | 'no_permission' | 'unreachable';

export type ConfluenceConnectResult =
  | { connected: true; connectorId: string; spacesVisible: number }
  | { connected: false; reason: ConfluenceConnectFailure };

export type ConfluenceReconnectResult =
  | { connected: true; spacesVisible: number }
  | { connected: false; reason: ConfluenceConnectFailure };

export const connectConfluence = (
  session: Session,
  request: { name: string; siteUrl: string; email: string; apiToken: string },
): Promise<ConfluenceConnectResult> => apiPost('/api/confluence/connect', request, session);
export const reconnectConfluence = (
  session: Session,
  id: string,
  request: { siteUrl: string; email: string; apiToken: string },
): Promise<ConfluenceReconnectResult> =>
  apiPost(`/api/confluence/${id}/credentials`, request, session);
export const requestConfluenceEstimate = (
  session: Session,
  id: string,
): Promise<{ enqueued: boolean }> => apiPost(`/api/confluence/${id}/estimate`, {}, session);

export const fetchConnectors = (session: Session): Promise<ConnectorDto[]> =>
  apiGet<{ connectors: ConnectorDto[] }>('/api/connectors', session).then(
    (page) => page.connectors,
  );
export const fetchConnectorDetail = (session: Session, id: string): Promise<ConnectorDetailDto> =>
  apiGet(`/api/connectors/${id}`, session);
export const updateConnectorSettings = (
  session: Session,
  id: string,
  patch: {
    backfillDays?: number;
    backfillItemCap?: number;
    backfillAll?: boolean;
    dailyItemCap?: number;
  },
): Promise<{ updated: boolean }> => apiPut(`/api/connectors/${id}/settings`, patch, session);
/** Sub-scope keys carry a colon (`space:ENG`), so the path segment is encoded. */
export const updateConnectorSubScope = (
  session: Session,
  id: string,
  key: string,
  patch: {
    selected?: boolean;
    itemCap?: number | null;
    attachments?: boolean;
    projectId?: string | null;
  },
): Promise<{ updated: boolean }> =>
  apiPut(`/api/connectors/${id}/sub-scopes/${encodeURIComponent(key)}`, patch, session);
export const addConnectorSubScope = (
  session: Session,
  id: string,
  request: { key: string; label: string },
): Promise<{ added: boolean }> => apiPost(`/api/connectors/${id}/sub-scopes`, request, session);
export const syncConnector = (session: Session, id: string): Promise<{ enqueued: boolean }> =>
  apiPost(`/api/connectors/${id}/sync`, {}, session);
export const sweepConnectorPresence = (
  session: Session,
  id: string,
): Promise<{ enqueued: boolean }> => apiPost(`/api/connectors/${id}/presence`, {}, session);
export interface ConnectorErasedItemDto {
  naturalKey: string;
  lastSeenAt: string;
  erasedAt: string;
}
export const fetchConnectorErasedItems = (
  session: Session,
  id: string,
): Promise<{ items: ConnectorErasedItemDto[] }> =>
  apiGet(`/api/connectors/${id}/erased-items`, session);
/** The explicit override of erased-stays-erased: per item, audited. */
export const reingestConnectorItem = (
  session: Session,
  id: string,
  naturalKey: string,
): Promise<{ released: boolean }> =>
  apiPost(`/api/connectors/${id}/erased-items/reingest`, { naturalKey }, session);
export const disableConnector = (session: Session, id: string): Promise<{ state: string }> =>
  apiPost(`/api/connectors/${id}/disable`, {}, session);
export const enableConnector = (session: Session, id: string): Promise<{ state: string }> =>
  apiPost(`/api/connectors/${id}/enable`, {}, session);
export async function removeConnector(
  session: Session,
  id: string,
): Promise<{ removed: boolean; credentialDestroyed: boolean }> {
  const path = `/api/connectors/${id}`;
  const response = await fetch(path, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok) throw await toError(path, response);
  return (await response.json()) as { removed: boolean; credentialDestroyed: boolean };
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

// The findings report (V2.3 item 6.2): a signed, printable artifact from a
// findings run. Trigger → poll (progress) → download per format.
export const triggerReport = (
  session: Session,
  scope: ReportScopeDto,
): Promise<FindingsReportDto> => apiPost('/api/reports', { scope }, session);
export const fetchReports = (session: Session): Promise<FindingsReportDto[]> =>
  apiGet('/api/reports', session);
export const fetchReportDownload = (
  session: Session,
  id: string,
  format: ReportDownloadFormat,
): Promise<ReportDownloadDto> => apiGet(`/api/reports/${id}/download?format=${format}`, session);

// Conversations: the sidebar's containers. Memory is the
// continuity, conversations are workspaces — deleting one is a SOURCE deletion
// (deleteSource with type 'chat_conversation'), never a chat route.
export const fetchConversations = (session: Session): Promise<ConversationDto[]> =>
  apiGet('/api/chat/conversations', session);
export const createConversation = (
  session: Session,
  projectId?: string | null,
): Promise<ConversationDto> =>
  apiPost('/api/chat/conversations', projectId ? { projectId } : {}, session);
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
/**
 * Stop a generation in flight (issue #532). Explicit, not a disconnect: the
 * server keeps what was written and flags it, and an already-finished
 * generation answers `false` rather than erroring.
 */
export const stopGeneration = (
  session: Session,
  generationId: string,
): Promise<{ stopped: boolean }> =>
  apiPost(`/api/chat/generations/${generationId}/stop`, {}, session);

/** Find a conversation by what was said in it (issue #530). */
export const searchConversations = (
  session: Session,
  q: string,
): Promise<ConversationSearchHitDto[]> =>
  apiGet(`/api/chat/search?q=${encodeURIComponent(q)}`, session);
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
  options: { thinking?: boolean; attachmentIds?: string[]; widen?: boolean } = {},
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
      // Widen THIS question past the project retrieval lens (V2.5 item 8.3).
      ...(options.widen ? { widen: true } : {}),
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

// Projects as workspaces (V2.5 item 8.3): the folder over conversations,
// sources, research runs, connector sub-scopes and reports. Organisation and
// filtering, never authorisation: what a user can see is decided exactly as
// it was, by ownership, scope and sensitivity.
export const fetchProjects = (
  session: Session,
  options: { archived?: boolean } = {},
): Promise<ProjectDto[]> =>
  apiGet(
    options.archived === undefined
      ? '/api/projects'
      : `/api/projects?archived=${String(options.archived)}`,
    session,
  );
export const fetchProject = (session: Session, id: string): Promise<ProjectDto> =>
  apiGet(`/api/projects/${id}`, session);
export const createProject = (session: Session, body: ProjectWriteDto): Promise<ProjectDto> =>
  apiPost('/api/projects', body, session);
export const updateProject = (
  session: Session,
  id: string,
  body: Partial<ProjectWriteDto>,
): Promise<ProjectDto> => apiPut(`/api/projects/${id}`, body, session);
export const setProjectArchived = (
  session: Session,
  id: string,
  archived: boolean,
): Promise<ProjectDto> => apiPut(`/api/projects/${id}/archived`, { archived }, session);
/** Deletes the FOLDER. Its contents survive and become unassigned. */
export async function deleteProject(session: Session, id: string): Promise<{ released: number }> {
  const path = `/api/projects/${id}`;
  const response = await fetch(path, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok) throw await toError(path, response);
  return (await response.json()) as { released: number };
}
export const assignToProject = (
  session: Session,
  ref: { kind: ProjectAssignmentKind; sourceType?: string; refId: string },
  projectId: string | null,
): Promise<{ projectId: string | null }> =>
  apiPost('/api/projects/assignments', { ...ref, projectId }, session);
