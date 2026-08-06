import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { FileProcessingState, MemoryScope } from '@cogeto/shared';
import { ALLOWED_UPLOAD_EXTENSIONS } from '@cogeto/shared';
import {
  fetchFileSource,
  fetchFileStatus,
  fetchSettings,
  reprocessSource,
  uploadFile,
} from '../api';
import type { Session } from '../auth/oidc';
import { validateUploadFile } from '../upload-validation';
import { Card } from './ui';

/**
 * The deliberate upload on Sources (V2.2 item 5.1, moved from Memories): the
 * path for documents you intend to keep and audit. Drag-or-select a document,
 * choose scope + sensitive, and it enters the SAME pipeline as every source;
 * the result lands on Sources, not in a conversation.
 */
export function UploadCard({
  session,
  onUploaded,
}: {
  session: Session;
  onUploaded: (objectKey: string, filename: string) => void;
}) {
  const { t } = useTranslation('sources');
  // Prefill scope + discard from the user's saved defaults.
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => fetchSettings(session) });
  const [scope, setScope] = useState<MemoryScope | null>(null);
  const [sensitive, setSensitive] = useState(false);
  const [discard, setDiscard] = useState<boolean | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const effScope = scope ?? settings.data?.defaultScope ?? 'private';
  const effDiscard = discard ?? settings.data?.discardByDefault ?? false;

  const upload = useMutation({
    mutationFn: ({ file }: { file: File }) =>
      uploadFile(session, file, { scope: effScope, sensitive, discard: effDiscard }),
    onSuccess: (result, { file }) => onUploaded(result.objectKey, file.name),
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const submit = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const problem = validateUploadFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    upload.mutate({ file });
  };

  return (
    <Card>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          submit(e.dataTransfer.files[0]);
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed p-6 text-center text-sm transition-colors ${
          dragging ? 'border-brand-teal bg-brand-teal/5' : 'border-slate-300'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ALLOWED_UPLOAD_EXTENSIONS.join(',')}
          className="hidden"
          onChange={(e) => {
            submit(e.target.files?.[0]);
            e.target.value = ''; // allow re-selecting the same file
          }}
        />
        <p className="font-medium text-slate-600">
          {upload.isPending ? t('upload.uploading') : t('upload.dropzone')}
        </p>
        <p className="mt-1 text-xs text-slate-400">{t('upload.hint')}</p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-slate-600">
        <label className="flex items-center gap-1.5">
          {t('upload.scope')}
          <select
            value={effScope}
            onChange={(e) => setScope(e.target.value as MemoryScope)}
            className="rounded-md border border-slate-300 px-2 py-1"
          >
            <option value="private">{t('common:memoryScope.private')}</option>
            <option value="shared">{t('common:memoryScope.shared')}</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(e) => setSensitive(e.target.checked)}
          />
          {t('upload.sensitive')}
        </label>
        <label className="flex items-center gap-1.5" title={t('upload.discardTitle')}>
          <input
            type="checkbox"
            checked={effDiscard}
            onChange={(e) => setDiscard(e.target.checked)}
          />
          {t('upload.discard')}
        </label>
      </div>

      {effDiscard && (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
          {t('upload.discardWarning')}
        </p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}

/**
 * File processing STATE is an API value; only its display name is translated,
 * through an explicit value → key map.
 */
const STATE_KEY: Record<FileProcessingState, string> = {
  processing: 'upload.state.processing',
  done: 'upload.state.done',
  error: 'upload.state.error',
};

/**
 * Read outcomes that mean the document produced NO text (V2.1 item 4.1).
 *
 * A job can succeed and read nothing, which is the case this exists for. The
 * upload row used to be dropped the moment the job succeeded, so a scan that
 * needed a vision model, or a page with nothing readable on it, vanished
 * without a word and looked exactly like a file that had been processed
 * normally. That is the one thing the reading layer must never do.
 */
const UNREAD_OUTCOMES = ['needs_vision', 'empty', 'read_failed', 'unsupported_format'];

/** How an upload ended, from the reader's point of view rather than the queue's. */
export type UploadOutcome = 'read' | 'unread' | 'failed';

/**
 * Polls one uploaded file's pipeline job until it settles, then asks what was
 * actually READ.
 *
 * The job's own state is not enough: it reports whether the pipeline ran, not
 * whether anything came out. A file that read nothing keeps its row, with the
 * reason and a way to try again once the missing capability exists.
 */
export function PendingUpload({
  session,
  objectKey,
  filename,
  onSettled,
}: {
  session: Session;
  objectKey: string;
  filename: string;
  onSettled: (objectKey: string, outcome: UploadOutcome) => void;
}) {
  const { t } = useTranslation('sources');
  const { data } = useQuery({
    queryKey: ['file-status', objectKey],
    queryFn: () => fetchFileStatus(session, objectKey),
    refetchInterval: (query) => (query.state.data?.state === 'processing' ? 1500 : false),
  });
  const state = data?.state ?? 'processing';
  const settled = state !== 'processing';

  // The read report, fetched once the job has settled: it is what says whether
  // anything was read, and it carries the reason when nothing was.
  const source = useQuery({
    queryKey: ['file-source', objectKey],
    queryFn: () => fetchFileSource(session, objectKey),
    enabled: settled && state !== 'error',
  });
  const read = source.data?.read ?? null;
  const unread = read !== null && UNREAD_OUTCOMES.includes(read.outcome);

  const [reprocessed, setReprocessed] = useState(false);
  const reprocess = useMutation({
    mutationFn: () => reprocessSource(session, objectKey),
    onSuccess: ({ queued }) => setReprocessed(queued),
  });

  useEffect(() => {
    if (!settled) return;
    if (state === 'error') onSettled(objectKey, 'failed');
    // Wait for the report before deciding: dropping the row first and asking
    // afterwards is how the unread case became invisible.
    else if (!source.isPending) onSettled(objectKey, unread ? 'unread' : 'read');
  }, [settled, state, unread, source.isPending, objectKey, onSettled]);

  const failed = state === 'error';
  const tone = failed
    ? 'border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300'
    : unread
      ? 'border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300'
      : 'border-slate-200 bg-surface text-slate-500';

  return (
    <div className={`space-y-1 rounded-md border px-3 py-2 text-sm ${tone}`}>
      <div className="flex items-center gap-2">
        {!failed && !unread && (
          <span className="h-2 w-2 animate-pulse rounded-full bg-brand-teal" aria-hidden="true" />
        )}
        <span className="truncate font-medium text-slate-600">{filename}</span>
        <span className="ml-auto text-xs">
          {unread && read
            ? t(`read.outcome.${read.outcome}`, { defaultValue: t(STATE_KEY[state]) })
            : t(STATE_KEY[state])}
        </span>
      </div>
      {unread && read && (
        <>
          {read.reasonCode && (
            <p className="text-xs">{t(`read.reason.${read.reasonCode}`, { defaultValue: '' })}</p>
          )}
          {reprocessed ? (
            <p className="text-xs">{t('read.reprocess.queued')}</p>
          ) : (
            <button
              type="button"
              disabled={reprocess.isPending}
              onClick={() => reprocess.mutate()}
              className="text-xs font-semibold underline underline-offset-2"
            >
              {t('read.reprocess.action')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
