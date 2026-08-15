import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import {
  assignToProject,
  deleteSource,
  draftEmailReply,
  fetchChatContext,
  fetchDeletionImpact,
  fetchEmailSource,
  fetchFileDownload,
  fetchFileSource,
  fetchNote,
  fetchProjects,
  fetchSourceInspection,
  fetchWebSource,
  reprocessSource,
  fetchSourceContext,
  setSourceContext,
} from '../api';
import { isRegisteredSourceType } from '@cogeto/shared';
import { useConfirm } from './confirm';
import type { SourceTypeKey } from '@cogeto/shared';
import type { SourceContextDto } from '@cogeto/shared';
import type { Session } from '../auth/oidc';
import { formatDateTime, formatFileSize } from '../i18n/format';
import { invalidateAfterSourceDeletion } from '../query-invalidation';
import {
  btnDanger,
  btnPrimary,
  btnSecondary,
  Drawer,
  ErrorState,
  Pill,
  SensitiveBadge,
  SkeletonRows,
  consequenceOf,
} from './ui';

import { EMAIL_FRAME_SANDBOX, emailFrameDocument } from './email-body';
import { InspectionPanels } from './InspectionPanels';
import type { Tone } from './status';
import { useApiErrorMessage } from '../i18n/api-error';

/**
 * File STATE is an API value; only its display name is translated, through an
 * explicit value → key map. An unknown state renders verbatim, as before.
 */
const FILE_STATE_KEY: Record<string, string> = {
  processing: 'fileState.processing',
  done: 'fileState.done',
  error: 'fileState.error',
};

/** Byte sizes go through the shared locale-aware formatter (Issue C). */
const formatBytes = (bytes: number | null): string | null => formatFileSize(bytes);

/**
 * The read OUTCOME and its reason are API enum values (V2.1 item 4.1); only
 * their display names are translated, through explicit value → key maps. An
 * unknown value renders nothing rather than a raw code.
 */
const READ_OUTCOME_KEY: Record<string, string> = {
  read: 'read.outcome.read',
  truncated: 'read.outcome.truncated',
  empty: 'read.outcome.empty',
  unsupported_format: 'read.outcome.unsupported_format',
  read_failed: 'read.outcome.read_failed',
  needs_vision: 'read.outcome.needs_vision',
};

const READ_REASON_KEY: Record<string, string> = {
  vision_unavailable: 'read.reason.vision_unavailable',
  vision_cap_reached: 'read.reason.vision_cap_reached',
  vision_failed: 'read.reason.vision_failed',
  no_readable_text: 'read.reason.no_readable_text',
  row_cap_sheet: 'read.reason.row_cap_sheet',
  row_cap_file: 'read.reason.row_cap_file',
  no_text: 'read.reason.no_text',
  unsupported_type: 'read.reason.unsupported_type',
  legacy_office_format: 'read.reason.legacy_office_format',
  parse_failed: 'read.reason.parse_failed',
  parse_timeout: 'read.reason.parse_timeout',
  text_over_cap: 'read.reason.text_over_cap',
  undecodable_text: 'read.reason.undecodable_text',
};

/** A partial read and a failed read are different news; so is a clean one. */
const readTone = (outcome: string): Tone =>
  outcome === 'read'
    ? 'positive'
    : outcome === 'truncated' || outcome === 'empty' || outcome === 'needs_vision'
      ? 'warning'
      : 'danger';

/** Which tier read a page. An API value; only its display name is translated. */
const READ_TIER_KEY: Record<string, string> = {
  text: 'read.tier.text',
  ocr: 'read.tier.ocr',
  vision: 'read.tier.vision',
};

/** A read that is missing pages can be retried once the capability exists. */
const canReprocess = (outcome: string): boolean =>
  outcome === 'needs_vision' || outcome === 'read_failed' || outcome === 'empty';

/**
 * The upstream-gone reason on a connector-synced source is an API value
 * (V2.5 item 8.2); only its notice sentence is translated, through an
 * explicit value → key map. An unknown value renders verbatim.
 */
const ORIGIN_GONE_NOTICE_KEY: Record<string, string> = {
  absent: 'origin.panel.notice.absent',
  archived: 'origin.panel.notice.archived',
};

/**
 * Which drawer body a source type gets, typed over the source-type registry's
 * union: adding a source type without deciding its drawer treatment is a
 * compile error, never a silent fallback. `none` (container and defunct
 * types) and an unrecognised runtime value show the raw source id, as before.
 */
const DRAWER_KIND: Record<SourceTypeKey, 'note' | 'file' | 'chat' | 'email' | 'web' | 'none'> = {
  user_note: 'note',
  file: 'file',
  chat: 'chat',
  email: 'email',
  web: 'web',
  chat_conversation: 'none',
  calendar_event: 'none',
  task_conclusion: 'none',
};

/**
 * The source drawer behind every memory: the original note verbatim (or the
 * object key for file sources), plus source-level TRUE deletion (spec §11.1, spec §11.1).
 * The confirm dialog states exactly what the saga will do; the server-side
 * saga is the authority — owner-only, one transaction, signed receipt.
 */
export function SourceDrawer({
  session,
  sourceType,
  sourceId,
  onClose,
  onDeleted,
  onOpenMemory,
}: {
  session: Session;
  sourceType: string;
  sourceId: string;
  onClose: () => void;
  /** Called after the saga accepted the deletion (receipt pending). */
  /** Called after the saga accepted the deletion. `receiptId` is null when
   * nothing erasable derived from the source, so there is no receipt to open
   * (SEC-30). */
  onDeleted: (receiptId: string | null) => void;
  /** Opens the fact detail (V2.2 item 5.2, level three); absent renders the
   * inspection's rows without navigation. */
  onOpenMemory?: (memoryId: string) => void;
}) {
  const { t } = useTranslation('sources');
  const apiError = useApiErrorMessage(t);
  const { t: tp } = useTranslation('projects');
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const drawerKind = isRegisteredSourceType(sourceType) ? DRAWER_KIND[sourceType] : 'none';
  const isNote = drawerKind === 'note';
  const isFile = drawerKind === 'file';
  const isChat = drawerKind === 'chat';
  const isEmail = drawerKind === 'email';
  const isWeb = drawerKind === 'web';
  const [draftError, setDraftError] = useState<string | null>(null);
  const [drafted, setDrafted] = useState(false);

  const noteQuery = useQuery({
    queryKey: ['note', sourceId],
    queryFn: () => fetchNote(session, sourceId),
    enabled: isNote,
  });
  const fileQuery = useQuery({
    queryKey: ['file-source', sourceId],
    queryFn: () => fetchFileSource(session, sourceId),
    enabled: isFile,
  });
  const chatQuery = useQuery({
    queryKey: ['chat-context', sourceId],
    queryFn: () => fetchChatContext(session, sourceId),
    enabled: isChat,
  });
  const emailQuery = useQuery({
    queryKey: ['email-source', sourceId],
    queryFn: () => fetchEmailSource(session, sourceId),
    enabled: isEmail,
  });
  const webQuery = useQuery({
    queryKey: ['web-source', sourceId],
    queryFn: () => fetchWebSource(session, sourceId),
    enabled: isWeb,
  });
  // The same inspection InspectionPanels fetches (same key, so react-query
  // dedups the request); the drawer only reads the connector origin off it.
  // Enabled for EVERY type since V2.5 item 8.3: the drawer reads the
  // connector origin and the source's project off it, and InspectionPanels
  // fetches the same key for every type anyway, so react-query dedups it.
  const inspectionQuery = useQuery({
    queryKey: ['source-inspection', sourceType, sourceId],
    queryFn: () => fetchSourceInspection(session, sourceType, sourceId),
  });
  const origin = inspectionQuery.data?.origin ?? null;
  const assignedProjectId = inspectionQuery.data?.projectId ?? null;
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => fetchProjects(session, { archived: false }),
  });
  const assign = useMutation({
    mutationFn: (projectId: string | null) =>
      assignToProject(session, { kind: 'source', sourceType, refId: sourceId }, projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['source-inspection', sourceType, sourceId] });
      void queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
  });
  const draftReply = useMutation({
    mutationFn: () => draftEmailReply(session, sourceId),
    onSuccess: () => {
      setDraftError(null);
      setDrafted(true);
    },
    onError: (e: unknown) => setDraftError(apiError(e)),
  });

  const [reprocessed, setReprocessed] = useState(false);
  const [reprocessError, setReprocessError] = useState<string | null>(null);
  const reprocess = useMutation({
    mutationFn: () => reprocessSource(session, sourceId),
    onSuccess: ({ queued }) => {
      setReprocessError(queued ? null : t('read.reprocess.noBytes'));
      setReprocessed(queued);
    },
    onError: (error: unknown) => setReprocessError(apiError(error, 'read.reprocess.failed')),
  });

  const download = useMutation({
    mutationFn: () => fetchFileDownload(session, sourceId),
    onSuccess: ({ url }) => window.open(url, '_blank', 'noopener'),
    onError: (error: unknown) => setDownloadError(apiError(error)),
  });
  const impactQuery = useQuery({
    queryKey: ['deletion-impact', sourceType, sourceId],
    queryFn: () => fetchDeletionImpact(session, sourceType, sourceId),
  });

  const remove = useMutation({
    mutationFn: () => deleteSource(session, sourceType, sourceId),
    onSuccess: async ({ receiptId }) => {
      await invalidateAfterSourceDeletion(queryClient); //: the deletion cascade only.
      onDeleted(receiptId);
    },
    onError: (error: unknown) => setDeleteError(apiError(error)),
  });

  const confirmAndDelete = async () => {
    const impact = impactQuery.data;
    if (!impact) return;
    // The consequence sentence is ONE key with named counts, so a translator
    // controls word order and plural agreement instead of receiving fragments.
    const asked = await confirm({
      title: t('delete.question', { subject: isNote ? t('kind.note') : t('kind.source') }),
      consequence: consequenceOf(
        t(impact.objectCount > 0 ? 'delete.confirmWithFiles' : 'delete.confirm', {
          subject: isNote ? t('kind.note') : t('kind.source'),
          memoryCount: impact.memoryCount,
          objectCount: impact.objectCount,
          memories: t('delete.derivedMemories', { count: impact.memoryCount }),
          files: t('delete.storedFiles', { count: impact.objectCount }),
        }),
      ),
      confirmLabel: t('delete.action'),
      destructive: true,
    });
    if (asked) remove.mutate();
  };

  const fileTone = (state: string): Tone =>
    state === 'error' ? 'danger' : state === 'done' ? 'positive' : 'warning';

  return (
    <Drawer
      title={t('drawer.title', {
        kind: t(`kindLabel.${sourceType}`, { defaultValue: sourceType.replace('_', ' ') }),
      })}
      onClose={onClose}
      width="max-w-md"
    >
      {isNote && noteQuery.isPending && <SkeletonRows rows={3} label={t('note.loading')} />}
      {isNote && noteQuery.isError && <ErrorState>{t('note.error')}</ErrorState>}
      {isNote && noteQuery.data && (
        <>
          <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-800">
            {noteQuery.data.content}
          </p>
          <p className="text-xs text-slate-400">
            {t('note.captured', { when: formatDateTime(noteQuery.data.createdAt) })}
          </p>
        </>
      )}
      {isFile && (
        <>
          {fileQuery.isPending && <SkeletonRows rows={2} label={t('file.loading')} />}
          {fileQuery.isError && <ErrorState>{t('file.error')}</ErrorState>}
          {fileQuery.data && (
            <div className="space-y-2 rounded-md bg-slate-50 p-3">
              <p className="break-words text-sm font-medium text-slate-800">
                {fileQuery.data.filename ??
                  (fileQuery.data.discarded ? t('file.discardedName') : t('file.uploadedName'))}
              </p>
              {fileQuery.data.discarded ? (
                <p className="rounded bg-amber-50 dark:bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
                  {t('file.discardedNote')}
                </p>
              ) : (
                <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  {fileQuery.data.contentType && <span>{fileQuery.data.contentType}</span>}
                  {formatBytes(fileQuery.data.sizeBytes) && (
                    <span>· {formatBytes(fileQuery.data.sizeBytes)}</span>
                  )}
                  <span>
                    {t('file.uploaded', { when: formatDateTime(fileQuery.data.uploadDate) })}
                  </span>
                </p>
              )}
              <p className="flex flex-wrap items-center gap-2 text-xs">
                <Pill tone={fileTone(fileQuery.data.state)}>
                  {FILE_STATE_KEY[fileQuery.data.state]
                    ? t(FILE_STATE_KEY[fileQuery.data.state]!)
                    : fileQuery.data.state}
                </Pill>
                {fileQuery.data.sensitive && <SensitiveBadge />}
                <span className="text-slate-400">
                  {t('scopeLine', { scope: t(`common:memoryScope.${fileQuery.data.scope}`) })}
                </span>
              </p>
              {fileQuery.data.read && (
                <div className="space-y-1 rounded-md border border-slate-200 bg-surface p-2">
                  <p className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium text-slate-600">{t('read.title')}</span>
                    <Pill tone={readTone(fileQuery.data.read.outcome)}>
                      {READ_OUTCOME_KEY[fileQuery.data.read.outcome]
                        ? t(READ_OUTCOME_KEY[fileQuery.data.read.outcome]!)
                        : fileQuery.data.read.outcome}
                    </Pill>
                  </p>
                  {fileQuery.data.read.reasonCode &&
                    READ_REASON_KEY[fileQuery.data.read.reasonCode] && (
                      <p className="text-xs text-slate-500">
                        {t(READ_REASON_KEY[fileQuery.data.read.reasonCode]!)}
                      </p>
                    )}
                  {fileQuery.data.read.sheets.length > 0 && (
                    <ul className="space-y-0.5 text-xs text-slate-500">
                      {fileQuery.data.read.sheets.map((sheet) => (
                        <li key={sheet.index} className="flex flex-wrap gap-1">
                          <span className="font-medium text-slate-600">
                            {sheet.name ?? t('read.unnamedSheet')}
                          </span>
                          <span>
                            {sheet.truncated
                              ? t('read.sheetRows', {
                                  rowsRead: sheet.rowsRead,
                                  rowsTotal: sheet.rowsTotal,
                                })
                              : t('read.sheetRowsAll', { rowsTotal: sheet.rowsTotal })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {fileQuery.data.read.valuesUnavailable > 0 && (
                    <p className="text-xs text-slate-500">
                      {t('read.valuesUnavailable', {
                        count: fileQuery.data.read.valuesUnavailable,
                      })}
                    </p>
                  )}
                  {fileQuery.data.read.pages && fileQuery.data.read.pages.length > 0 && (
                    <div className="space-y-0.5 text-xs text-slate-500">
                      <p className="font-medium text-slate-600">{t('read.tier.title')}</p>
                      <p>
                        {t('read.tier.summary', {
                          read: fileQuery.data.read.pages.filter((page) => page.tier !== null)
                            .length,
                          total: fileQuery.data.read.pages.length,
                        })}
                      </p>
                      <ul className="flex flex-wrap gap-x-3">
                        {fileQuery.data.read.pages.map((page) => (
                          <li key={page.page}>
                            {page.page}:{' '}
                            {page.tier && READ_TIER_KEY[page.tier]
                              ? t(READ_TIER_KEY[page.tier]!)
                              : t('read.tier.unread')}
                          </li>
                        ))}
                      </ul>
                      {(fileQuery.data.read.visionPagesUsed ?? 0) > 0 && (
                        <p>
                          {t('read.tier.visionPages', {
                            count: fileQuery.data.read.visionPagesUsed ?? 0,
                          })}
                        </p>
                      )}
                    </div>
                  )}
                  {canReprocess(fileQuery.data.read.outcome) && !fileQuery.data.discarded && (
                    <div className="space-y-1 pt-1">
                      <p className="text-xs text-slate-500">{t('read.reprocess.explainer')}</p>
                      <button
                        type="button"
                        disabled={reprocess.isPending || reprocessed}
                        onClick={() => reprocess.mutate()}
                        className={btnSecondary}
                      >
                        {t('read.reprocess.action')}
                      </button>
                      {reprocessed && (
                        <p className="text-xs text-slate-500">{t('read.reprocess.queued')}</p>
                      )}
                      {reprocessError && (
                        <p className="text-xs text-red-600 dark:text-red-300">{reprocessError}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
              {/* Which project groups this source (V2.5 item 8.3 issue C3),
                  and the reversible control to move it. Organisation, never
                  authorisation: moving a source changes nothing about who
                  can see its facts. */}
              {(projects ?? []).length > 0 && (
                <div className="space-y-1 rounded-md border border-slate-200 bg-surface p-2">
                  <label
                    className="text-xs font-medium text-slate-600"
                    htmlFor={`source-project-${sourceId}`}
                  >
                    {tp('assign.label')}
                  </label>
                  <select
                    id={`source-project-${sourceId}`}
                    value={assignedProjectId ?? ''}
                    disabled={assign.isPending}
                    onChange={(event) => assign.mutate(event.target.value || null)}
                    className="w-full rounded-md border border-slate-300 bg-surface px-2 py-1 text-xs text-slate-700"
                  >
                    <option value="">{tp('assign.none')}</option>
                    {(projects ?? []).map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {origin && (
                <div className="space-y-1 rounded-md border border-slate-200 bg-surface p-2">
                  <p className="text-xs font-medium text-slate-600">
                    {t('origin.panel.heading', {
                      connector: t(`origin.connectorLabel.${origin.connectorKind}`, {
                        defaultValue: origin.connectorKind,
                      }),
                    })}
                  </p>
                  <div className="space-y-0.5 text-xs text-slate-600">
                    {origin.title && <p className="font-medium text-slate-700">{origin.title}</p>}
                    {(origin.spaceName ?? origin.spaceKey) && (
                      <p>
                        {t('origin.panel.space', {
                          space:
                            origin.spaceName && origin.spaceKey
                              ? `${origin.spaceName} (${origin.spaceKey})`
                              : (origin.spaceName ?? origin.spaceKey),
                        })}
                      </p>
                    )}
                    {origin.version !== null && (
                      <p>{t('origin.panel.version', { version: origin.version })}</p>
                    )}
                    {origin.parentTitle && (
                      <p>{t('origin.panel.parent', { title: origin.parentTitle })}</p>
                    )}
                  </div>
                  {origin.url && (
                    <p className="break-all text-xs">
                      <a
                        href={origin.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand-teal-ink dark:text-brand-teal hover:underline"
                      >
                        {t('origin.panel.open')}
                      </a>
                    </p>
                  )}
                  {origin.upstreamGone && (
                    <p className="rounded bg-amber-50 dark:bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
                      {ORIGIN_GONE_NOTICE_KEY[origin.upstreamGone]
                        ? t(ORIGIN_GONE_NOTICE_KEY[origin.upstreamGone]!)
                        : origin.upstreamGone}
                    </p>
                  )}
                </div>
              )}
              <AnchorContextPanel session={session} sourceId={sourceId} />
              {!fileQuery.data.discarded && (
                <>
                  <button
                    type="button"
                    disabled={download.isPending}
                    onClick={() => {
                      setDownloadError(null);
                      download.mutate();
                    }}
                    className={btnSecondary}
                  >
                    {download.isPending ? t('file.preparing') : t('file.downloadOriginal')}
                  </button>
                  {downloadError && (
                    <p className="text-xs text-red-600 dark:text-red-300">{downloadError}</p>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
      {isChat && (
        <>
          {chatQuery.isPending && <SkeletonRows rows={3} label={t('conversation.loading')} />}
          {chatQuery.isError && <ErrorState>{t('conversation.error')}</ErrorState>}
          {chatQuery.data && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">
                <Trans
                  i18nKey="conversation.lead"
                  ns="sources"
                  values={{
                    title: chatQuery.data.conversationTitle ?? t('chat:conversation.untitled'),
                  }}
                  components={{ title: <span className="font-semibold text-slate-700" /> }}
                />
              </p>
              <a
                href={`/chat?c=${chatQuery.data.conversationId}&m=${encodeURIComponent(sourceId)}`}
                className="inline-block text-xs font-semibold text-brand-teal-ink underline underline-offset-2 hover:opacity-80 dark:text-brand-teal"
              >
                {t('conversation.openInThread')}
              </a>
              {chatQuery.data.turns.map((turn) => (
                <div
                  key={turn.id}
                  className={`rounded-md p-2 text-sm ${
                    turn.isTarget
                      ? 'border border-brand-teal/50 bg-brand-teal/5 text-slate-800'
                      : 'bg-slate-50 text-slate-500'
                  }`}
                >
                  <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    {turn.role === 'user' ? t('chat:role.you') : t('common:productName')}
                    {turn.isTarget && t('conversation.rememberedSuffix')}
                  </p>
                  <p className="whitespace-pre-wrap">{turn.content}</p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {isEmail && (
        <>
          {emailQuery.isPending && <SkeletonRows rows={4} label={t('email.loading')} />}
          {emailQuery.isError && <ErrorState>{t('email.error')}</ErrorState>}
          {emailQuery.data && (
            <div className="space-y-3">
              <div className="space-y-1 rounded-md bg-slate-50 p-3 text-sm">
                <p className="font-semibold text-slate-800">
                  {emailQuery.data.subject || t('email:noSubject')}
                </p>
                <p className="text-xs text-slate-500">
                  <span className="font-medium">{t('email.from')}</span> {emailQuery.data.from}
                </p>
                <p className="text-xs text-slate-500">
                  <span className="font-medium">{t('email.to')}</span> {emailQuery.data.to}
                </p>
                <p className="text-xs text-slate-400">
                  {formatDateTime(emailQuery.data.sentAt ?? emailQuery.data.receivedAt)}
                </p>
                {emailQuery.data.isForward && emailQuery.data.originalCorrespondent && (
                  <p className="mt-1 rounded bg-brand-teal/5 px-2 py-1 text-xs text-brand-teal-ink dark:text-brand-teal">
                    <Trans
                      i18nKey="email.originallyFrom"
                      ns="sources"
                      values={{ sender: emailQuery.data.originalCorrespondent }}
                      components={{ sender: <span className="font-medium" /> }}
                    />
                  </p>
                )}
                {emailQuery.data.isForward && !emailQuery.data.originalCorrespondent && (
                  <p className="mt-1 rounded bg-amber-50 dark:bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
                    {t('email.forwardUnknownSender')}
                  </p>
                )}
                <p className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                  {emailQuery.data.sensitive && <SensitiveBadge />}
                  <span className="text-slate-400">
                    {t('scopeLine', { scope: t(`common:memoryScope.${emailQuery.data.scope}`) })}
                  </span>
                </p>
              </div>

              {/* Body: text preferred (safe); for HTML-only mail, the
                  parser-sanitised HTML is rendered inside a SANDBOXED IFRAME
                  (audit 2.0 SEC-7) — no script execution, no same-origin
                  access, no remote loads — so a sanitizer bypass has nowhere to
                  run. See ./email-body.ts. */}
              {emailQuery.data.textBody ? (
                <p className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 p-3 text-sm text-slate-700">
                  {emailQuery.data.textBody}
                </p>
              ) : emailQuery.data.htmlBody ? (
                <iframe
                  title={t('email.bodyFrameTitle')}
                  className="h-72 w-full rounded-md border border-slate-200 bg-white"
                  sandbox={EMAIL_FRAME_SANDBOX}
                  referrerPolicy="no-referrer"
                  srcDoc={emailFrameDocument(emailQuery.data.htmlBody)}
                />
              ) : (
                <p className="text-xs text-slate-400">{t('email.noBody')}</p>
              )}

              {emailQuery.data.attachments.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-500">
                    {t('email.attachments')}
                  </p>
                  <ul className="space-y-1">
                    {emailQuery.data.attachments.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2 py-1 text-xs"
                      >
                        <span className="min-w-0 truncate text-slate-700">
                          {a.filename ?? t('email.attachmentFallback')}
                          {formatBytes(a.sizeBytes) && (
                            <span className="text-slate-400"> · {formatBytes(a.sizeBytes)}</span>
                          )}
                        </span>
                        {a.downloadable && a.fileObjectKey ? (
                          <button
                            type="button"
                            onClick={() =>
                              fetchFileDownload(session, a.fileObjectKey!).then(({ url }) =>
                                window.open(url, '_blank', 'noopener'),
                              )
                            }
                            className="shrink-0 text-brand-teal-ink dark:text-brand-teal hover:underline"
                          >
                            {t('common:action.download')}
                          </button>
                        ) : (
                          <span className="shrink-0 text-slate-400">{t('email.retained')}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Draft reply — the reliable, discoverable trigger. */}
              <div className="rounded-lg border border-brand-teal/30 bg-brand-teal/5 p-3">
                {drafted ? (
                  <p className="text-sm text-slate-700">
                    <Trans
                      i18nKey="email.draftCreated"
                      ns="sources"
                      components={{
                        link: (
                          <a
                            href="/approvals"
                            className="font-medium text-brand-teal-ink dark:text-brand-teal hover:underline"
                          />
                        ),
                      }}
                    />
                  </p>
                ) : (
                  <>
                    <p className="mb-2 text-xs text-slate-500">{t('email.draftExplainer')}</p>
                    <button
                      type="button"
                      disabled={draftReply.isPending}
                      onClick={() => draftReply.mutate()}
                      className={btnPrimary}
                    >
                      {draftReply.isPending ? t('email.drafting') : t('email.draftReply')}
                    </button>
                    {draftError && (
                      <p className="mt-2 text-xs text-red-600 dark:text-red-300">{draftError}</p>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
      {isWeb && (
        <>
          {webQuery.isPending && <SkeletonRows rows={3} label={t('web.loading')} />}
          {webQuery.isError && <ErrorState>{t('web.error')}</ErrorState>}
          {webQuery.data && (
            <div className="space-y-2 rounded-md bg-slate-50 p-3">
              <p className="break-words text-sm font-medium text-slate-800">
                {webQuery.data.title ?? webQuery.data.finalUrl}
              </p>
              <p className="break-all text-xs">
                <a
                  href={webQuery.data.finalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-teal-ink dark:text-brand-teal hover:underline"
                >
                  {webQuery.data.finalUrl}
                </a>
              </p>
              <p className="text-xs text-slate-400">
                {t('web.fetched', { when: formatDateTime(webQuery.data.fetchedAt) })}
              </p>
              <p className="flex flex-wrap items-center gap-2 text-xs">
                {webQuery.data.sensitive && <SensitiveBadge />}
                <span className="text-slate-400">
                  {t('scopeLine', { scope: t(`common:memoryScope.${webQuery.data.scope}`) })}
                </span>
              </p>
              <p className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 p-3 text-sm text-slate-700">
                {webQuery.data.retainedText}
              </p>
            </div>
          )}
        </>
      )}
      {!isNote && !isFile && !isChat && !isEmail && !isWeb && (
        <p className="break-all rounded-md bg-slate-50 p-3 text-xs text-slate-600">{sourceId}</p>
      )}

      {/* Level two of the Sources surface (V2.2 item 5.2): the facts with
          their located spans, the suppressed log, the contradictions. */}
      <InspectionPanels
        session={session}
        sourceType={sourceType}
        sourceId={sourceId}
        onOpenMemory={onOpenMemory}
      />

      {deleteError && <ErrorState>{deleteError}</ErrorState>}

      <section className="rounded-lg border border-red-200 dark:border-red-500/30 p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-300">
          {t('delete.dangerZone')}
        </h3>
        <p className="mb-2 text-xs text-slate-500">
          {impactQuery.data
            ? t(impactQuery.data.objectCount > 0 ? 'delete.impactWithFiles' : 'delete.impact', {
                memories: t('delete.derivedMemories', { count: impactQuery.data.memoryCount }),
                files: t('delete.storedFiles', { count: impactQuery.data.objectCount }),
              })
            : t('delete.computingImpact')}
        </p>
        <button
          type="button"
          disabled={remove.isPending || !impactQuery.data}
          onClick={() => void confirmAndDelete()}
          className={btnDanger}
        >
          {remove.isPending ? t('delete.deleting') : t('delete.deleteSource')}
        </button>
      </section>
    </Drawer>
  );
}

/**
 * The anchoring context (V2.1 item 4.2): what this document is about, read
 * from its opening; editable, and authoritative once edited. Re-anchoring is
 * the reprocess action above — the panel only says so.
 */
function AnchorContextPanel({ session, sourceId }: { session: Session; sourceId: string }) {
  const { t } = useTranslation('sources');
  const apiError = useApiErrorMessage(t);
  const queryClient = useQueryClient();
  const context = useQuery<SourceContextDto | null>({
    queryKey: ['source-context', sourceId],
    queryFn: async () => {
      try {
        return await fetchSourceContext(session, 'file', sourceId);
      } catch {
        // No context yet (or not this owner's): the panel offers to create one.
        return null;
      }
    },
  });

  const [editing, setEditing] = useState(false);
  const [subjects, setSubjects] = useState('');
  const [documentClass, setDocumentClass] = useState('');
  const [revision, setRevision] = useState('');
  const [saved, setSaved] = useState(false);

  const beginEdit = () => {
    const data = context.data;
    setSubjects((data?.subjects ?? []).map((subject) => subject.name).join(', '));
    setDocumentClass(data?.documentClass ?? '');
    setRevision(data?.revision ?? '');
    setSaved(false);
    setEditing(true);
  };

  const save = useMutation({
    mutationFn: () =>
      setSourceContext(session, 'file', sourceId, {
        subjects: subjects
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
          .map((name) => ({ name })),
        documentClass: documentClass.trim() || null,
        revision: revision.trim() || null,
      }),
    onSuccess: async () => {
      setEditing(false);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['source-context', sourceId] });
    },
  });

  if (context.isPending) return null;
  const data = context.data;

  return (
    <div className="space-y-1 rounded-md border border-slate-200 bg-surface p-2">
      <p className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-slate-600">{t('anchor.title')}</span>
        {!editing && (
          <button
            type="button"
            onClick={beginEdit}
            className="text-xs text-brand-teal-ink dark:text-brand-teal hover:underline"
          >
            {t('anchor.editAction')}
          </button>
        )}
      </p>
      {!editing && (
        <>
          {data ? (
            <div className="space-y-0.5 text-xs text-slate-600">
              {data.subjects.length > 0 && (
                <p>
                  {t('anchor.subjects')}:{' '}
                  {data.subjects
                    .map(
                      (subject) =>
                        subject.name + (subject.confident ? '' : ' ' + t('anchor.uncertain')),
                    )
                    .join(', ')}
                </p>
              )}
              {data.documentClass && (
                <p>
                  {t('anchor.documentClass')}: {data.documentClass}
                  {data.documentClassConfident ? '' : ' ' + t('anchor.uncertain')}
                </p>
              )}
              {data.revision && (
                <p>
                  {t('anchor.revision')}: {data.revision}
                  {data.revisionConfident ? '' : ' ' + t('anchor.uncertain')}
                </p>
              )}
              <p className="text-slate-400">
                {data.editedByUser ? t('anchor.edited') : t('anchor.detected')}
              </p>
            </div>
          ) : (
            <p className="text-xs text-slate-400">{t('anchor.none')}</p>
          )}
          {saved && <p className="text-xs text-slate-500">{t('anchor.saveHint')}</p>}
        </>
      )}
      {editing && (
        <div className="space-y-2">
          <label className="block text-xs text-slate-500">
            <span className="block">{t('anchor.subjects')}</span>
            <input
              value={subjects}
              onChange={(e) => setSubjects(e.target.value)}
              placeholder={t('anchor.subjectsPlaceholder')}
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <label className="text-xs text-slate-500">
              <span className="block">{t('anchor.documentClass')}</span>
              <input
                value={documentClass}
                onChange={(e) => setDocumentClass(e.target.value)}
                className="mt-1 w-40 rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-slate-500">
              <span className="block">{t('anchor.revision')}</span>
              <input
                value={revision}
                onChange={(e) => setRevision(e.target.value)}
                className="mt-1 w-32 rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className={btnSecondary}
            >
              {t('common:action.save')}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-xs text-slate-500 hover:underline"
            >
              {t('common:action.cancel')}
            </button>
          </div>
          {save.isError && (
            <p className="text-xs text-red-600 dark:text-red-300">
              {apiError(save.error, 'anchor.saveFailed')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
