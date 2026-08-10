import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type {
  ImportItemDto,
  ImportRunDetailDto,
  ImportRunDto,
  MemoryScope,
  S3ManifestRequest,
} from '@cogeto/shared';
import {
  cancelImport,
  confirmImport,
  createFolderImport,
  createS3Import,
  createZipImport,
  excludeImportItems,
  fetchImportDetail,
  fetchImports,
  fetchSettings,
  stageImportItem,
} from '../api';
import type { Session } from '../auth/oidc';
import { Card, ErrorState, Pill } from './ui';
import type { Tone } from './status';
import { timeAgo } from './status';

/**
 * Bulk import (V2.2 item 5.3): the wizard (ZIP, folder, S3-style path), the
 * manifest review with exclusions, the honest progress card, and the durable
 * completion summary whose numbers link to their evidence. Nothing is
 * ingested until the manifest is confirmed; S3 credentials live in component
 * state for the confirm call and nowhere else.
 */

type WizardTab = 'zip' | 'folder' | 's3';

const badgeTone: Partial<Record<ImportItemDto['state'], Tone>> = {
  duplicate: 'neutral',
  unsupported: 'warning',
  failed: 'danger',
  excluded: 'neutral',
  cancelled: 'neutral',
  ingested: 'info',
  queued: 'info',
};

function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function ImportPanel({ session }: { session: Session }) {
  const { t } = useTranslation('sources');
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<WizardTab | null>(null);
  const [manifest, setManifest] = useState<ImportRunDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Folder mode keeps the picked File handles until confirm uploads them. */
  const folderFiles = useRef<Map<string, File>>(new Map());
  /** S3 mode keeps the credentials for the ONE confirm call, nowhere else. */
  const s3Creds = useRef<S3ManifestRequest | null>(null);

  const runs = useQuery({
    queryKey: ['imports'],
    queryFn: () => fetchImports(session),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((run) => run.state === 'running') ? 4000 : false,
  });

  // A run finishing is new sources: refresh the catalog underneath.
  const runningCount = (runs.data ?? []).filter((run) => run.state === 'running').length;
  const lastRunning = useRef(runningCount);
  useEffect(() => {
    if (runningCount < lastRunning.current) {
      void queryClient.invalidateQueries({ queryKey: ['sources'] });
      void queryClient.invalidateQueries({ queryKey: ['memories'] });
    }
    lastRunning.current = runningCount;
  }, [runningCount, queryClient]);

  const openManifest = (detail: ImportRunDetailDto) => {
    setManifest(detail);
    setError(null);
    void queryClient.invalidateQueries({ queryKey: ['imports'] });
  };
  const fail = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : t('imports.error'));

  const visibleRuns = (runs.data ?? []).filter((run) => run.id !== manifest?.id);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            setTab((value) => (value === null ? 'zip' : null));
            setError(null);
          }}
          className="rounded-lg border border-brand-teal/40 bg-brand-teal/10 px-3 py-1.5 text-sm font-medium text-brand-teal-ink transition-colors hover:bg-brand-teal/20 dark:text-brand-teal"
        >
          {tab === null ? t('imports.open') : t('imports.close')}
        </button>
        <p className="text-sm text-slate-500">{t('imports.intro')}</p>
      </div>

      {tab !== null && !manifest && (
        <Card>
          <div className="mb-3 flex gap-1.5">
            {(['zip', 'folder', 's3'] as const).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={tab === key}
                onClick={() => setTab(key)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  tab === key
                    ? 'border-brand-teal bg-brand-teal/10 text-brand-teal-ink dark:text-brand-teal'
                    : 'border-slate-300 text-slate-500 hover:border-slate-400'
                }`}
              >
                {t(`imports.tab.${key}`)}
              </button>
            ))}
          </div>
          {tab === 'zip' && <ZipStep session={session} onManifest={openManifest} onError={fail} />}
          {tab === 'folder' && (
            <FolderStep
              session={session}
              files={folderFiles}
              onManifest={openManifest}
              onError={fail}
            />
          )}
          {tab === 's3' && (
            <S3Step session={session} creds={s3Creds} onManifest={openManifest} onError={fail} />
          )}
          {error && <ErrorState>{error}</ErrorState>}
        </Card>
      )}

      {manifest && (
        <ManifestReview
          session={session}
          detail={manifest}
          folderFiles={folderFiles.current}
          s3Creds={s3Creds}
          onUpdate={setManifest}
          onDone={() => {
            setManifest(null);
            setTab(null);
            folderFiles.current = new Map();
            s3Creds.current = null;
            void queryClient.invalidateQueries({ queryKey: ['imports'] });
          }}
        />
      )}

      {visibleRuns.length > 0 && (
        <div className="space-y-2">
          {visibleRuns.map((run) => (
            <ImportRunCard key={run.id} session={session} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}

function ZipStep({
  session,
  onManifest,
  onError,
}: {
  session: Session;
  onManifest: (detail: ImportRunDetailDto) => void;
  onError: (cause: unknown) => void;
}) {
  const { t } = useTranslation('sources');
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const create = useMutation({
    mutationFn: (file: File) => createZipImport(session, file),
    onSuccess: onManifest,
    onError,
  });
  return (
    <div className="space-y-2 text-sm">
      <div
        role="button"
        tabIndex={0}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file && !create.isPending) create.mutate(file);
        }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed p-6 text-center transition-colors ${
          dragging ? 'border-brand-teal bg-brand-teal/5' : 'border-slate-300 hover:border-slate-400'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) create.mutate(file);
            event.target.value = '';
          }}
        />
        <p className="font-medium text-slate-600">
          {create.isPending ? t('imports.reading') : t('imports.zipDropzone')}
        </p>
        <p className="mt-1 text-xs text-slate-400">{t('imports.zipExplainer')}</p>
      </div>
    </div>
  );
}

function FolderStep({
  session,
  files,
  onManifest,
  onError,
}: {
  session: Session;
  files: React.MutableRefObject<Map<string, File>>;
  onManifest: (detail: ImportRunDetailDto) => void;
  onError: (cause: unknown) => void;
}) {
  const { t } = useTranslation('sources');
  const inputRef = useRef<HTMLInputElement>(null);
  const [hashing, setHashing] = useState<{ done: number; total: number } | null>(null);
  const create = useMutation({
    mutationFn: async (picked: File[]) => {
      setHashing({ done: 0, total: picked.length });
      const items: { name: string; sizeBytes: number; contentHash: string }[] = [];
      const map = new Map<string, File>();
      for (const file of picked) {
        const name = (file as { webkitRelativePath?: string }).webkitRelativePath || file.name;
        items.push({ name, sizeBytes: file.size, contentHash: await sha256Hex(file) });
        map.set(name, file);
        setHashing((state) => state && { ...state, done: state.done + 1 });
      }
      files.current = map;
      const label = items[0]?.name.split('/')[0];
      return createFolderImport(session, { sourceLabel: label, items });
    },
    onSuccess: onManifest,
    onError,
    onSettled: () => setHashing(null),
  });
  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs text-slate-500">{t('imports.folderExplainer')}</p>
      <input
        ref={inputRef}
        type="file"
        multiple
        {...({ webkitdirectory: '' } as object)}
        onChange={(event) => {
          const picked = [...(event.target.files ?? [])];
          if (picked.length > 0) create.mutate(picked);
          event.target.value = '';
        }}
        className="hidden"
      />
      <button
        type="button"
        disabled={create.isPending}
        onClick={() => inputRef.current?.click()}
        className="rounded-md bg-brand-teal px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {create.isPending ? t('imports.reading') : t('imports.pickFolder')}
      </button>
      {hashing && (
        <p className="text-xs text-slate-500">
          {t('imports.hashing', { done: hashing.done, total: hashing.total })}
        </p>
      )}
    </div>
  );
}

function S3Step({
  session,
  creds,
  onManifest,
  onError,
}: {
  session: Session;
  creds: React.MutableRefObject<S3ManifestRequest | null>;
  onManifest: (detail: ImportRunDetailDto) => void;
  onError: (cause: unknown) => void;
}) {
  const { t } = useTranslation('sources');
  const [form, setForm] = useState({
    url: '',
    accessKey: '',
    secretKey: '',
    bucket: '',
    prefix: '',
  });
  const create = useMutation({
    mutationFn: () => {
      const request: S3ManifestRequest = { ...form, prefix: form.prefix || undefined };
      creds.current = request;
      return createS3Import(session, request);
    },
    onSuccess: onManifest,
    onError,
  });
  const field = (key: keyof typeof form, type = 'text') => (
    <label className="flex flex-col gap-0.5 text-xs text-slate-600">
      {t(`imports.s3.${key}`)}
      <input
        type={type}
        value={form[key]}
        autoComplete="off"
        onChange={(event) => setForm((state) => ({ ...state, [key]: event.target.value }))}
        className="rounded-md border border-slate-300 px-2 py-1 text-sm"
      />
    </label>
  );
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">{t('imports.s3.explainer')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {field('url')}
        {field('bucket')}
        {field('accessKey')}
        {field('secretKey', 'password')}
        {field('prefix')}
      </div>
      <button
        type="button"
        disabled={
          create.isPending || !form.url || !form.bucket || !form.accessKey || !form.secretKey
        }
        onClick={() => create.mutate()}
        className="rounded-md bg-brand-teal px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {create.isPending ? t('imports.listing') : t('imports.s3.list')}
      </button>
    </div>
  );
}

/** The manifest: what will happen, per file, before anything does. */
function ManifestReview({
  session,
  detail,
  folderFiles,
  s3Creds,
  onUpdate,
  onDone,
}: {
  session: Session;
  detail: ImportRunDetailDto;
  folderFiles: Map<string, File>;
  s3Creds: React.MutableRefObject<S3ManifestRequest | null>;
  onUpdate: (detail: ImportRunDetailDto) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation('sources');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [staging, setStaging] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The whole run's scope (issue #490): one deliberate choice at the
  // deliberate step, prefilled from the user's saved default like the
  // single-file upload card.
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => fetchSettings(session) });
  const [scope, setScope] = useState<MemoryScope | null>(null);
  const [sensitive, setSensitive] = useState(false);
  const effScope = scope ?? settings.data?.defaultScope ?? 'private';

  const listed = detail.items.filter((item) => item.state === 'listed');
  const candidates = listed.filter((item) => item.revisionOf).length;

  const exclude = useMutation({
    mutationFn: () => excludeImportItems(session, detail.id, [...selected]),
    onSuccess: (next) => {
      onUpdate(next);
      setSelected(new Set());
    },
    onError: (cause) => setError(cause.message),
  });

  const confirm = useMutation({
    mutationFn: async () => {
      if (detail.kind === 'folder') {
        // Bytes follow the reviewed manifest: upload only what stayed in.
        setStaging({ done: 0, total: listed.length });
        for (const item of listed) {
          const file = item.name ? folderFiles.get(item.name) : undefined;
          if (!file) throw new Error(t('imports.missingFile', { name: item.name ?? '' }));
          await stageImportItem(session, detail.id, item.id, file);
          setStaging((state) => state && { ...state, done: state.done + 1 });
        }
      }
      return confirmImport(session, detail.id, {
        s3: detail.kind === 's3' ? (s3Creds.current ?? undefined) : undefined,
        scope: effScope,
        sensitive,
      });
    },
    onSuccess: onDone,
    onError: (cause) => setError(cause.message),
    onSettled: () => setStaging(null),
  });

  const discard = useMutation({
    mutationFn: () => cancelImport(session, detail.id),
    onSuccess: onDone,
    onError: (cause) => setError(cause.message),
  });

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card>
      <h3 className="text-sm font-semibold text-slate-700">{t('imports.manifest.title')}</h3>
      <p className="mt-1 text-xs text-slate-500">
        {t('imports.manifest.summary', {
          included: listed.length,
          duplicates: detail.progress.duplicates,
          unsupported: detail.progress.unsupported,
        })}
        {candidates > 0 && <> {t('imports.manifest.revisionCandidates', { count: candidates })}</>}
      </p>
      <ul className="mt-2 max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200 text-sm">
        {detail.items.map((item) => (
          <li key={item.id} className="flex items-center gap-2 px-2.5 py-1.5">
            {item.state === 'listed' ? (
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onChange={() => toggle(item.id)}
                aria-label={t('imports.manifest.selectForExclusion', { name: item.name ?? '' })}
              />
            ) : (
              <span className="w-3.5" />
            )}
            <span className="min-w-0 flex-1 truncate text-slate-700">{item.name}</span>
            <span className="text-xs text-slate-400">{formatSize(item.sizeBytes)}</span>
            {item.state !== 'listed' && (
              <Pill tone={badgeTone[item.state] ?? 'neutral'}>
                {t(`imports.itemState.${item.state}`)}
              </Pill>
            )}
            {item.state === 'listed' && item.revisionOf && (
              <Pill tone="info">{t('imports.manifest.revisionCandidate')}</Pill>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-slate-600">
        <span className="text-xs text-slate-500">{t('imports.manifest.scopeLabel')}</span>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="import-scope"
            checked={effScope === 'private'}
            onChange={() => setScope('private')}
          />
          {t('imports.manifest.scopePrivate')}
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="import-scope"
            checked={effScope === 'shared'}
            onChange={() => setScope('shared')}
          />
          {t('imports.manifest.scopeShared')}
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(event) => setSensitive(event.target.checked)}
          />
          {t('imports.manifest.sensitive')}
        </label>
      </div>
      <p className="mt-1 text-xs text-slate-400">{t('imports.manifest.scopeHelp')}</p>
      {staging && (
        <p className="mt-2 text-xs text-slate-500">
          {t('imports.manifest.stagingProgress', { done: staging.done, total: staging.total })}
        </p>
      )}
      {error && <ErrorState>{error}</ErrorState>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={confirm.isPending || listed.length === 0}
          onClick={() => confirm.mutate()}
          className="rounded-md bg-brand-teal px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {confirm.isPending
            ? t('imports.manifest.confirming')
            : t('imports.manifest.confirm', { count: listed.length })}
        </button>
        {selected.size > 0 && (
          <button
            type="button"
            disabled={exclude.isPending}
            onClick={() => exclude.mutate()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600"
          >
            {t('imports.manifest.exclude', { count: selected.size })}
          </button>
        )}
        <button
          type="button"
          disabled={discard.isPending || confirm.isPending}
          onClick={() => discard.mutate()}
          className="text-sm text-slate-500 underline underline-offset-2"
        >
          {t('imports.manifest.discard')}
        </button>
      </div>
    </Card>
  );
}

/** One run: honest progress while running, the durable summary after. */
function ImportRunCard({ session, run }: { session: Session; run: ImportRunDto }) {
  const { t } = useTranslation('sources');
  const queryClient = useQueryClient();
  const [showItems, setShowItems] = useState<ImportItemDto['state'] | 'revisions' | null>(null);
  const detail = useQuery({
    queryKey: ['import-detail', run.id],
    queryFn: () => fetchImportDetail(session, run.id),
    enabled: showItems !== null,
  });
  const cancel = useMutation({
    mutationFn: () => cancelImport(session, run.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['imports'] }),
  });

  const counts = run.counts;
  const progress = run.progress;
  const label = run.sourceLabel ?? t(`imports.tab.${run.kind}`);
  const shownItems = (detail.data?.items ?? []).filter((item) =>
    showItems === 'revisions' ? item.revisionOf !== null : item.state === showItems,
  );

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-slate-700">{t('imports.run.title', { label })}</span>
        <Pill
          tone={
            run.state === 'running' ? 'info' : run.state === 'completed' ? 'neutral' : 'warning'
          }
        >
          {t(`imports.runState.${run.state}`)}
        </Pill>
        {run.scope === 'shared' && <Pill tone="info">{t('imports.run.sharedScope')}</Pill>}
        {run.sensitive === true && <Pill tone="warning">{t('imports.run.sensitiveScope')}</Pill>}
        <span className="ml-auto text-xs text-slate-400" title={run.createdAt}>
          {timeAgo(run.createdAt)}
        </span>
      </div>

      {run.state === 'running' && (
        <div className="mt-2 space-y-1.5">
          <p className="text-sm text-slate-600">
            {t('imports.run.progress', {
              done: progress.done,
              total:
                progress.total - progress.duplicates - progress.unsupported - progress.excluded,
              failed: progress.failed,
            })}
          </p>
          {run.pausedReason === 'daily_upload_limit' && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              {t('imports.run.pausedDailyCap')}
            </p>
          )}
          <button
            type="button"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
            className="text-xs text-slate-500 underline underline-offset-2"
          >
            {t('imports.run.cancel')}
          </button>
        </div>
      )}

      {counts && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
          <CountChip
            label={t('imports.summary.documents', { count: counts.documents })}
            onClick={() => setShowItems((v) => (v === 'ingested' ? null : 'ingested'))}
          />
          <CountLink label={t('imports.summary.facts', { count: counts.facts })} href="/memories" />
          {counts.contradictions > 0 && (
            <CountLink
              label={t('imports.summary.contradictions', { count: counts.contradictions })}
              href="/review"
              tone="danger"
            />
          )}
          {counts.superseded > 0 && (
            <CountLink
              label={t('imports.summary.superseded', { count: counts.superseded })}
              href="/memories"
            />
          )}
          {counts.revisionsLinked + counts.revisionsProposed > 0 && (
            <CountChip
              label={t('imports.summary.revisions', {
                linked: counts.revisionsLinked,
                proposed: counts.revisionsProposed,
              })}
              onClick={() => setShowItems((v) => (v === 'revisions' ? null : 'revisions'))}
            />
          )}
          {counts.duplicatesSkipped > 0 && (
            <CountChip
              label={t('imports.summary.duplicates', { count: counts.duplicatesSkipped })}
              onClick={() => setShowItems((v) => (v === 'duplicate' ? null : 'duplicate'))}
            />
          )}
          {counts.gated > 0 && (
            <CountChip
              label={t('imports.summary.gated', { count: counts.gated })}
              onClick={() => setShowItems((v) => (v === 'ingested' ? null : 'ingested'))}
            />
          )}
          {counts.unreadable > 0 && (
            <CountChip
              label={t('imports.summary.unreadable', { count: counts.unreadable })}
              tone="danger"
              onClick={() => setShowItems((v) => (v === 'ingested' ? null : 'ingested'))}
            />
          )}
          {counts.truncated > 0 && (
            <CountChip
              label={t('imports.summary.truncated', { count: counts.truncated })}
              tone="warning"
              onClick={() => setShowItems((v) => (v === 'ingested' ? null : 'ingested'))}
            />
          )}
          {counts.failed > 0 && (
            <CountChip
              label={t('imports.summary.failed', { count: counts.failed })}
              tone="danger"
              onClick={() => setShowItems((v) => (v === 'failed' ? null : 'failed'))}
            />
          )}
          {counts.excluded > 0 && (
            <CountChip
              label={t('imports.summary.excluded', { count: counts.excluded })}
              onClick={() => setShowItems((v) => (v === 'excluded' ? null : 'excluded'))}
            />
          )}
          {counts.unsupported > 0 && (
            <CountChip
              label={t('imports.summary.unsupported', { count: counts.unsupported })}
              tone="warning"
              onClick={() => setShowItems((v) => (v === 'unsupported' ? null : 'unsupported'))}
            />
          )}
          {counts.cancelled > 0 && (
            <CountChip
              label={t('imports.summary.cancelled', { count: counts.cancelled })}
              onClick={() => setShowItems((v) => (v === 'cancelled' ? null : 'cancelled'))}
            />
          )}
        </div>
      )}

      {showItems !== null && detail.data && (
        <ul className="mt-2 max-h-60 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200 text-sm">
          {shownItems.length === 0 && (
            <li className="px-2.5 py-1.5 text-xs text-slate-400">{t('imports.run.noItems')}</li>
          )}
          {shownItems.map((item) => (
            <li key={item.id} className="flex items-center gap-2 px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate text-slate-700">
                {item.name ?? t('imports.run.erasedItem')}
              </span>
              {item.reason && <span className="text-xs text-slate-400">{item.reason}</span>}
              {item.objectKey && (
                <a
                  href={`/sources?src=${encodeURIComponent(`file:${item.objectKey}`)}`}
                  className="text-xs font-medium text-brand-teal-ink underline-offset-2 hover:underline dark:text-brand-teal"
                >
                  {t('imports.run.viewSource')}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CountChip({ label, tone, onClick }: { label: string; tone?: Tone; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="cursor-pointer">
      <Pill tone={tone ?? 'neutral'}>{label}</Pill>
    </button>
  );
}

function CountLink({ label, href, tone }: { label: string; href: string; tone?: Tone }) {
  return (
    <a href={href}>
      <Pill tone={tone ?? 'neutral'}>{label}</Pill>
    </a>
  );
}
