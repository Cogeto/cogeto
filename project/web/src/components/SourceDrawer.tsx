import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteSource,
  draftEmailReply,
  fetchChatContext,
  fetchDeletionImpact,
  fetchEmailSource,
  fetchFileDownload,
  fetchFileSource,
  fetchNote,
  fetchTaskConclusion,
  fetchWebSource,
} from '../api';
import type { Session } from '../auth/oidc';
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
} from './ui';

/**
 * Neutralize remote content in retained email HTML before rendering (Session O4).
 * The intake sanitizer already strips scripts/handlers/js: URLs; here we also
 * stop remote resources (tracking pixels) from auto-loading — the choice most
 * mail clients make and the hardest to misuse. Formatting is preserved.
 */
function neutralizeRemoteHtml(html: string): string {
  return html
    .replace(/\s(src|background)\s*=\s*("|')?\s*https?:[^"'\s>]*/gi, ' data-remote-src="blocked"')
    .replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/url\(\s*['"]?https?:[^)]*\)/gi, 'none');
}
import type { Tone } from './status';

const FILE_STATE_LABEL: Record<string, string> = {
  processing: 'Extracting…',
  done: 'Extracted',
  error: 'Extraction failed',
};

function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The source drawer behind every memory: the original note verbatim (or the
 * object key for file sources), plus source-level TRUE deletion (§A.7, §B.1).
 * The confirm dialog states exactly what the saga will do; the server-side
 * saga is the authority — owner-only, one transaction, signed receipt.
 */
export function SourceDrawer({
  session,
  sourceType,
  sourceId,
  onClose,
  onDeleted,
}: {
  session: Session;
  sourceType: string;
  sourceId: string;
  onClose: () => void;
  /** Called after the saga accepted the deletion (receipt pending). */
  onDeleted: (receiptId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const isNote = sourceType === 'user_note';
  const isFile = sourceType === 'file';
  const isChat = sourceType === 'chat';
  const isEmail = sourceType === 'email';
  const isTaskConclusion = sourceType === 'task_conclusion';
  const isWeb = sourceType === 'web';
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
  const conclusionQuery = useQuery({
    queryKey: ['task-conclusion', sourceId],
    queryFn: () => fetchTaskConclusion(session, sourceId),
    enabled: isTaskConclusion,
  });
  const webQuery = useQuery({
    queryKey: ['web-source', sourceId],
    queryFn: () => fetchWebSource(session, sourceId),
    enabled: isWeb,
  });
  const draftReply = useMutation({
    mutationFn: () => draftEmailReply(session, sourceId),
    onSuccess: () => {
      setDraftError(null);
      setDrafted(true);
    },
    onError: (e: unknown) => setDraftError(e instanceof Error ? e.message : String(e)),
  });

  const download = useMutation({
    mutationFn: () => fetchFileDownload(session, sourceId),
    onSuccess: ({ url }) => window.open(url, '_blank', 'noopener'),
    onError: (error: unknown) =>
      setDownloadError(error instanceof Error ? error.message : String(error)),
  });
  const impactQuery = useQuery({
    queryKey: ['deletion-impact', sourceType, sourceId],
    queryFn: () => fetchDeletionImpact(session, sourceType, sourceId),
  });

  const remove = useMutation({
    mutationFn: () => deleteSource(session, sourceType, sourceId),
    onSuccess: async ({ receiptId }) => {
      await invalidateAfterSourceDeletion(queryClient); // QS-36: the deletion cascade only.
      onDeleted(receiptId);
    },
    onError: (error: unknown) =>
      setDeleteError(error instanceof Error ? error.message : String(error)),
  });

  const confirmAndDelete = () => {
    const impact = impactQuery.data;
    if (!impact) return;
    const memories = `${impact.memoryCount} derived memor${impact.memoryCount === 1 ? 'y' : 'ies'}`;
    const files =
      impact.objectCount > 0
        ? ` and ${impact.objectCount} stored file${impact.objectCount === 1 ? '' : 's'}`
        : '';
    const message =
      `This will PERMANENTLY remove this ${isNote ? 'note' : 'source'}, ${memories}${files}. ` +
      'A signed deletion receipt will be issued as proof. This cannot be undone.\n\nDelete?';
    if (window.confirm(message)) remove.mutate();
  };

  const fileTone = (state: string): Tone =>
    state === 'error' ? 'danger' : state === 'done' ? 'positive' : 'warning';

  return (
    <Drawer
      title={`Source · ${isNote ? 'note' : isChat ? 'conversation' : sourceType.replace('_', ' ')}`}
      onClose={onClose}
      width="max-w-md"
    >
      {isNote && noteQuery.isPending && <SkeletonRows rows={3} label="Loading note…" />}
      {isNote && noteQuery.isError && (
        <ErrorState>We couldn’t load this note right now.</ErrorState>
      )}
      {isNote && noteQuery.data && (
        <>
          <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-800">
            {noteQuery.data.content}
          </p>
          <p className="text-xs text-slate-400">
            Captured {new Date(noteQuery.data.createdAt).toLocaleString()}
          </p>
        </>
      )}
      {isFile && (
        <>
          {fileQuery.isPending && <SkeletonRows rows={2} label="Loading file…" />}
          {fileQuery.isError && <ErrorState>We couldn’t load this file source.</ErrorState>}
          {fileQuery.data && (
            <div className="space-y-2 rounded-md bg-slate-50 p-3">
              <p className="break-words text-sm font-medium text-slate-800">
                {fileQuery.data.filename ??
                  (fileQuery.data.discarded ? 'Discarded document' : 'Uploaded document')}
              </p>
              {fileQuery.data.discarded ? (
                <p className="rounded bg-amber-50 dark:bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
                  Original discarded after extraction. Only the derived memories remain (§A.9).
                  Provenance is intact; there is nothing to download.
                </p>
              ) : (
                <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  {fileQuery.data.contentType && <span>{fileQuery.data.contentType}</span>}
                  {formatBytes(fileQuery.data.sizeBytes) && (
                    <span>· {formatBytes(fileQuery.data.sizeBytes)}</span>
                  )}
                  <span>· uploaded {new Date(fileQuery.data.uploadDate).toLocaleString()}</span>
                </p>
              )}
              <p className="flex flex-wrap items-center gap-2 text-xs">
                <Pill tone={fileTone(fileQuery.data.state)}>
                  {FILE_STATE_LABEL[fileQuery.data.state] ?? fileQuery.data.state}
                </Pill>
                {fileQuery.data.sensitive && <SensitiveBadge />}
                <span className="text-slate-400">scope: {fileQuery.data.scope}</span>
              </p>
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
                    {download.isPending ? 'Preparing…' : 'Download original'}
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
          {chatQuery.isPending && <SkeletonRows rows={3} label="Loading conversation…" />}
          {chatQuery.isError && <ErrorState>We couldn’t load the conversation.</ErrorState>}
          {chatQuery.data && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">
                Remembered from chat. The highlighted message is the source; nearby turns are shown
                for context.
              </p>
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
                    {turn.role === 'user' ? 'You' : 'Cogeto'}
                    {turn.isTarget && ' · remembered'}
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
          {emailQuery.isPending && <SkeletonRows rows={4} label="Loading email…" />}
          {emailQuery.isError && <ErrorState>We couldn’t load this email.</ErrorState>}
          {emailQuery.data && (
            <div className="space-y-3">
              <div className="space-y-1 rounded-md bg-slate-50 p-3 text-sm">
                <p className="font-semibold text-slate-800">
                  {emailQuery.data.subject || '(no subject)'}
                </p>
                <p className="text-xs text-slate-500">
                  <span className="font-medium">From:</span> {emailQuery.data.from}
                </p>
                <p className="text-xs text-slate-500">
                  <span className="font-medium">To:</span> {emailQuery.data.to}
                </p>
                <p className="text-xs text-slate-400">
                  {new Date(emailQuery.data.sentAt ?? emailQuery.data.receivedAt).toLocaleString()}
                </p>
                {emailQuery.data.isForward && emailQuery.data.originalCorrespondent && (
                  <p className="mt-1 rounded bg-brand-teal/5 px-2 py-1 text-xs text-brand-teal-ink dark:text-brand-teal">
                    Originally from:{' '}
                    <span className="font-medium">{emailQuery.data.originalCorrespondent}</span>. A
                    reply will go to them, not the forwarder.
                  </p>
                )}
                {emailQuery.data.isForward && !emailQuery.data.originalCorrespondent && (
                  <p className="mt-1 rounded bg-amber-50 dark:bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
                    This arrived as a forward; the original sender couldn’t be recovered, so a reply
                    will leave the recipient for you to fill in.
                  </p>
                )}
                <p className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                  {emailQuery.data.sensitive && <SensitiveBadge />}
                  <span className="text-slate-400">scope: {emailQuery.data.scope}</span>
                </p>
              </div>

              {/* Body: text preferred (safe); sanitised HTML with remote content
                  blocked as the fallback for HTML-only mail. */}
              {emailQuery.data.textBody ? (
                <p className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 p-3 text-sm text-slate-700">
                  {emailQuery.data.textBody}
                </p>
              ) : emailQuery.data.htmlBody ? (
                <div
                  className="max-h-72 overflow-auto rounded-md border border-slate-200 p-3 text-sm text-slate-700"
                  // Sanitised at intake (scripts/handlers/js: stripped) + remote
                  // content neutralised here so nothing external auto-loads.
                  dangerouslySetInnerHTML={{
                    __html: neutralizeRemoteHtml(emailQuery.data.htmlBody),
                  }}
                />
              ) : (
                <p className="text-xs text-slate-400">(no body)</p>
              )}

              {emailQuery.data.attachments.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-500">Attachments</p>
                  <ul className="space-y-1">
                    {emailQuery.data.attachments.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2 py-1 text-xs"
                      >
                        <span className="min-w-0 truncate text-slate-700">
                          {a.filename ?? 'attachment'}
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
                            Download
                          </button>
                        ) : (
                          <span className="shrink-0 text-slate-400">retained</span>
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
                    Draft created. Review it on the{' '}
                    <a
                      href="/approvals"
                      className="font-medium text-brand-teal-ink dark:text-brand-teal hover:underline"
                    >
                      Approvals
                    </a>{' '}
                    page, then send it from your own mail client. Cogeto never sends mail.
                  </p>
                ) : (
                  <>
                    <p className="mb-2 text-xs text-slate-500">
                      Cogeto will write a suggested reply you can edit and send yourself. It never
                      sends mail. You approve and send from your own client.
                    </p>
                    <button
                      type="button"
                      disabled={draftReply.isPending}
                      onClick={() => draftReply.mutate()}
                      className={btnPrimary}
                    >
                      {draftReply.isPending ? 'Drafting…' : 'Draft reply'}
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
      {isTaskConclusion && (
        <>
          {conclusionQuery.isPending && <SkeletonRows rows={2} label="Loading conclusion…" />}
          {conclusionQuery.isError && (
            <ErrorState>We couldn’t load this task conclusion.</ErrorState>
          )}
          {conclusionQuery.data && (
            <div className="space-y-2 rounded-md bg-slate-50 p-3">
              <p className="text-xs text-slate-500">
                Derived by the task engine when{' '}
                {conclusionQuery.data.conclusionType === 'condition_met'
                  ? 'a task’s waiting condition was satisfied'
                  : 'a task concluded'}{' '}
                (decision 0037). This statement entered the normal pipeline like any other source.
              </p>
              <p className="whitespace-pre-wrap text-sm text-slate-800">
                {conclusionQuery.data.statement}
              </p>
              <p className="flex flex-wrap items-center gap-2 text-xs">
                <a href="/tasks" className="underline underline-offset-2">
                  Open Tasks
                </a>
                {conclusionQuery.data.derivingMemoryId && (
                  <a
                    href={`/memories?open=${conclusionQuery.data.derivingMemoryId}`}
                    className="underline underline-offset-2"
                  >
                    the commitment it concluded
                  </a>
                )}
                {conclusionQuery.data.triggerMemoryId && (
                  <a
                    href={`/memories?open=${conclusionQuery.data.triggerMemoryId}`}
                    className="underline underline-offset-2"
                  >
                    the fact that concluded it
                  </a>
                )}
              </p>
            </div>
          )}
        </>
      )}
      {isWeb && (
        <>
          {webQuery.isPending && <SkeletonRows rows={3} label="Loading page…" />}
          {webQuery.isError && <ErrorState>We couldn’t load this web source.</ErrorState>}
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
                Fetched {new Date(webQuery.data.fetchedAt).toLocaleString()}. Facts from this page
                are “as of” that moment.
              </p>
              <p className="flex flex-wrap items-center gap-2 text-xs">
                {webQuery.data.sensitive && <SensitiveBadge />}
                <span className="text-slate-400">scope: {webQuery.data.scope}</span>
              </p>
              <p className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 p-3 text-sm text-slate-700">
                {webQuery.data.retainedText}
              </p>
            </div>
          )}
        </>
      )}
      {!isNote && !isFile && !isChat && !isEmail && !isTaskConclusion && !isWeb && (
        <p className="break-all rounded-md bg-slate-50 p-3 text-xs text-slate-600">{sourceId}</p>
      )}

      {deleteError && <ErrorState>{deleteError}</ErrorState>}

      <section className="rounded-lg border border-red-200 dark:border-red-500/30 p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-300">
          Danger zone
        </h3>
        <p className="mb-2 text-xs text-slate-500">
          {impactQuery.data
            ? `Deleting this source removes it, ${impactQuery.data.memoryCount} derived ` +
              `memor${impactQuery.data.memoryCount === 1 ? 'y' : 'ies'}` +
              (impactQuery.data.objectCount > 0
                ? ` and ${impactQuery.data.objectCount} stored file${impactQuery.data.objectCount === 1 ? '' : 's'}`
                : '') +
              ', permanently, with a signed receipt as proof.'
            : 'Computing what deletion would remove…'}
        </p>
        <button
          type="button"
          disabled={remove.isPending || !impactQuery.data}
          onClick={confirmAndDelete}
          className={btnDanger}
        >
          {remove.isPending ? 'Deleting…' : 'Delete source…'}
        </button>
      </section>
    </Drawer>
  );
}
