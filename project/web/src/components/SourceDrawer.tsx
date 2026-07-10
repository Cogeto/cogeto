import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteSource,
  fetchChatContext,
  fetchDeletionImpact,
  fetchFileDownload,
  fetchFileSource,
  fetchNote,
} from '../api';
import type { Session } from '../auth/oidc';
import {
  btnDanger,
  btnSecondary,
  Drawer,
  ErrorState,
  Pill,
  SensitiveBadge,
  SkeletonRows,
} from './ui';
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
      await queryClient.invalidateQueries();
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
                <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
                  Original discarded after extraction — only the derived memories remain (§A.9).
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
                  {downloadError && <p className="text-xs text-red-600">{downloadError}</p>}
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
                Remembered from chat — the highlighted message is the source; nearby turns are shown
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
      {!isNote && !isFile && !isChat && (
        <p className="break-all rounded-md bg-slate-50 p-3 text-xs text-slate-600">{sourceId}</p>
      )}

      {deleteError && <ErrorState>{deleteError}</ErrorState>}

      <section className="rounded-lg border border-red-200 p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-600">
          Danger zone
        </h3>
        <p className="mb-2 text-xs text-slate-500">
          {impactQuery.data
            ? `Deleting this source removes it, ${impactQuery.data.memoryCount} derived ` +
              `memor${impactQuery.data.memoryCount === 1 ? 'y' : 'ies'}` +
              (impactQuery.data.objectCount > 0
                ? ` and ${impactQuery.data.objectCount} stored file${impactQuery.data.objectCount === 1 ? '' : 's'}`
                : '') +
              ' — permanently, with a signed receipt as proof.'
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
