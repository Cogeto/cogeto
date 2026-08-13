import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { SourceBadgeFilter, SourceCatalogItemDto, SourceTypeKey } from '@cogeto/shared';
import { SOURCE_BADGE_FILTERS, SOURCE_TYPE_KEYS } from '@cogeto/shared';
import {
  fetchModelConfig, fetchProjects, fetchSourceCatalog } from '../api';
import type { Session } from '../auth/oidc';
import { ImportPanel } from '../components/ImportPanel';
import { MemoryDrawer } from '../components/MemoryDrawer';
import { Shell } from '../components/Shell';
import { SourceDrawer } from '../components/SourceDrawer';
import { timeAgo } from '../components/status';
import type { Tone } from '../components/status';
import { UploadCard, PendingUpload } from '../components/UploadCard';
import { Card, ErrorState, Pill, SkeletonRows } from '../components/ui';

/**
 * Sources (V2.2 item 5.2): the read, audit and resolve surface — where you
 * see and prove what the system knows. Level one is this list (one row per
 * source, badges as the scan layer); level two is the source drawer's
 * inspection (facts with located spans, the suppressed log, contradictions in
 * context); level three is the fact drawer. The deliberate upload (5.1) stays
 * at the top; bulk import (5.3) joins it here.
 */

/** The types the catalog lists — container and defunct types never row. */
const LISTED_TYPES = SOURCE_TYPE_KEYS.filter(
  (type): type is SourceTypeKey =>
    !['chat_conversation', 'task_conclusion', 'calendar_event'].includes(type),
);

/** ?open=<objectKey> (the 5.1 chat-card link) or ?src=<type>:<id>. */
function openedFromUrl(): { sourceType: string; sourceId: string } | null {
  const params = new URLSearchParams(window.location.search);
  const legacy = params.get('open');
  if (legacy) return { sourceType: 'file', sourceId: legacy };
  const src = params.get('src');
  if (!src) return null;
  const split = src.indexOf(':');
  if (split <= 0) return null;
  return { sourceType: src.slice(0, split), sourceId: src.slice(split + 1) };
}

export function Sources({ session }: { session: Session }) {
  const { t } = useTranslation('sources');
  const { t: tp } = useTranslation('projects');
  const queryClient = useQueryClient();

  const [type, setType] = useState<string>('');
  const [badge, setBadge] = useState<SourceBadgeFilter | ''>('');
  const [q, setQ] = useState('');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  /** Only this project's sources (V2.5 item 8.3 issue C3). A filter over
   * containers: nothing it hides stops being the caller's own source. */
  const [projectId, setProjectId] = useState<string>('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [uploads, setUploads] = useState<{ objectKey: string; filename: string }[]>([]);
  const [openSource, setOpenSource] = useState(openedFromUrl);
  const [openMemoryId, setOpenMemoryId] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => fetchProjects(session),
  });
  const projectNames = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project.name])),
    [projects],
  );

  const cursor = cursors[cursors.length - 1];
  const params = useMemo(
    () => ({
      type: type || undefined,
      badge: badge || undefined,
      projectId: projectId || undefined,
      q: q.trim() || undefined,
      order,
      cursor,
    }),
    [type, badge, projectId, q, order, cursor],
  );
  // The first-run state: uploads and imports run the extraction pipeline, so
  // both doors are disabled with the shared explanation until a model
  // provider is configured (same cache key as the shell banner).
  const modelConfigQuery = useQuery({
    queryKey: ['model-config'],
    queryFn: () => fetchModelConfig(session),
    refetchInterval: 30_000,
  });
  const modelsOff = modelConfigQuery.data?.configured === false;

  const page = useQuery({
    queryKey: ['sources', params],
    queryFn: () => fetchSourceCatalog(session, params),
  });

  const resetPaging = () => setCursors([]);
  const openDrawer = (ref: { sourceType: string; sourceId: string } | null) => {
    setOpenSource(ref);
    const url = ref
      ? `/sources?src=${encodeURIComponent(`${ref.sourceType}:${ref.sourceId}`)}`
      : '/sources';
    window.history.replaceState(null, '', url);
  };

  const items = page.data?.items ?? [];
  const firstRun = !page.isPending && !page.isError && items.length === 0 && !q && !type && !badge;

  return (
    <Shell session={session} title={t('navigation:section.sources')} active="sources">
      {/* The deliberate door (5.1): kept, one action away. */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setShowUpload((value) => !value)}
          disabled={modelsOff}
          title={modelsOff ? t('common:modelRequired.short') : undefined}
          className="rounded-lg border border-brand-teal/40 bg-brand-teal/10 px-3 py-1.5 text-sm font-medium text-brand-teal-ink transition-colors hover:bg-brand-teal/20 disabled:opacity-40 dark:text-brand-teal"
        >
          {showUpload ? t('page.hideUpload') : t('page.uploadHeading')}
        </button>
        <p className="text-sm text-slate-500">
          {modelsOff ? t('common:modelRequired.short') : t('page.uploadIntro')}
        </p>
      </div>
      {showUpload && !modelsOff && (
        <UploadCard
          session={session}
          onUploaded={(objectKey, filename) =>
            setUploads((list) => [...list, { objectKey, filename }])
          }
          // Already stored (issue #536): open what they already have, rather
          // than adding a row for an ingestion that correctly did not happen.
          onDuplicate={(objectKey) => openDrawer({ sourceType: 'file', sourceId: objectKey })}
        />
      )}
      {/* Bulk import (5.3): manifest first, honest progress, durable summary.
          Hidden with the shared explanation above while no model provider is
          configured — an import would only queue work that must wait. */}
      {!modelsOff && <ImportPanel session={session} />}
      {uploads.map((upload) => (
        <PendingUpload
          key={upload.objectKey}
          session={session}
          objectKey={upload.objectKey}
          filename={upload.filename}
          onSettled={() => {
            void queryClient.invalidateQueries({ queryKey: ['sources'] });
            void queryClient.invalidateQueries({ queryKey: ['memories'] });
          }}
        />
      ))}

      {/* The scan layer's controls: search, type, order, badge conditions. */}
      <Card>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <input
            value={q}
            onChange={(event) => {
              setQ(event.target.value);
              resetPaging();
            }}
            placeholder={t('list.searchPlaceholder')}
            className="min-w-48 flex-1 rounded-md border border-slate-300 px-3 py-1.5"
          />
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            {t('list.typeLabel')}
            <select
              value={type}
              onChange={(event) => {
                setType(event.target.value);
                resetPaging();
              }}
              className="rounded-md border border-slate-300 px-2 py-1"
            >
              <option value="">{t('list.typeAll')}</option>
              {LISTED_TYPES.map((key) => (
                <option key={key} value={key}>
                  {t(`kindLabel.${key}`, { defaultValue: key })}
                </option>
              ))}
            </select>
          </label>
          {(projects ?? []).length > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              {tp('filter.label')}
              <select
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  resetPaging();
                }}
                className="rounded-md border border-slate-300 px-2 py-1"
              >
                <option value="">{tp('filter.all')}</option>
                {(projects ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            onClick={() => {
              setOrder((value) => (value === 'desc' ? 'asc' : 'desc'));
              resetPaging();
            }}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600"
          >
            {order === 'desc' ? t('list.orderNewest') : t('list.orderOldest')}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {SOURCE_BADGE_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={badge === key}
              onClick={() => {
                setBadge((current) => (current === key ? '' : key));
                resetPaging();
              }}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                badge === key
                  ? 'border-brand-teal bg-brand-teal/10 text-brand-teal-ink dark:text-brand-teal'
                  : 'border-slate-300 text-slate-500 hover:border-slate-400'
              }`}
            >
              {t(`list.badgeFilter.${key}`)}
            </button>
          ))}
        </div>
      </Card>

      {page.isPending && <SkeletonRows rows={6} label={t('list.loading')} />}
      {page.isError && <ErrorState>{t('list.error')}</ErrorState>}

      {firstRun && (
        <div className="space-y-1 rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          <p>{t('list.firstRun.what')}</p>
          <p>{t('list.firstRun.how')}</p>
        </div>
      )}
      {!firstRun && !page.isPending && !page.isError && items.length === 0 && (
        <p className="text-sm text-slate-400">{t('list.emptyFiltered')}</p>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200">
          {items.map((item) => (
            <SourceRow
              key={`${item.sourceType}:${item.sourceId}`}
              item={item}
              projectName={item.projectId ? projectNames.get(item.projectId) : undefined}
              onOpen={() => openDrawer({ sourceType: item.sourceType, sourceId: item.sourceId })}
            />
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        {cursors.length > 0 && (
          <button
            type="button"
            onClick={() => setCursors((list) => list.slice(0, -1))}
            className="text-xs font-semibold text-slate-500 underline underline-offset-2"
          >
            {t('list.pageBack')}
          </button>
        )}
        {page.data?.nextCursor && (
          <button
            type="button"
            onClick={() => setCursors((list) => [...list, page.data.nextCursor!])}
            className="text-xs font-semibold text-slate-500 underline underline-offset-2"
          >
            {t('list.pageMore')}
          </button>
        )}
      </div>

      <p className="text-xs text-slate-400">
        <a href="/memories" className="underline underline-offset-2">
          {t('list.factSearchLink')}
        </a>
      </p>

      {openSource && (
        <SourceDrawer
          session={session}
          sourceType={openSource.sourceType}
          sourceId={openSource.sourceId}
          onOpenMemory={(id) => setOpenMemoryId(id)}
          onClose={() => openDrawer(null)}
          onDeleted={() => {
            openDrawer(null);
            void queryClient.invalidateQueries({ queryKey: ['sources'] });
          }}
        />
      )}
      {openMemoryId && (
        <MemoryDrawer
          session={session}
          memoryId={openMemoryId}
          onClose={() => setOpenMemoryId(null)}
          onNavigate={setOpenMemoryId}
        />
      )}
    </Shell>
  );
}

/**
 * The upstream-gone reason on a connector-synced source is an API value
 * (V2.5 item 8.2); only its display name is translated. Unknown values
 * render verbatim.
 */
const ORIGIN_GONE_KEY: Record<string, string> = {
  absent: 'origin.gone.absent',
  archived: 'origin.gone.archived',
};

/** One catalog row: name, date, fact count, and ONLY the badges that flag. */
function SourceRow({
  item,
  projectName,
  onOpen,
}: {
  item: SourceCatalogItemDto;
  /** The project this source is grouped under (V2.5 item 8.3), when it has
   * one and the name resolved. */
  projectName?: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation('sources');
  const badges = item.badges;
  const flag = (tone: Tone, label: string, key: string) => (
    <Pill key={key} tone={tone}>
      {label}
    </Pill>
  );
  const flags = [
    badges.contradictions > 0 &&
      flag('danger', t('list.badge.contradictions', { count: badges.contradictions }), 'c'),
    badges.superseded > 0 &&
      flag('neutral', t('list.badge.superseded', { count: badges.superseded }), 's'),
    badges.suppressed > 0 &&
      flag('warning', t('list.badge.suppressed', { count: badges.suppressed }), 'p'),
    badges.truncated && flag('warning', t('list.badge.truncated'), 't'),
    badges.gated && flag('warning', t('list.badge.gated'), 'g'),
    badges.unreadable && flag('danger', t('list.badge.unreadable'), 'u'),
    badges.processing && flag('info', t('list.badge.processing'), 'r'),
  ].filter(Boolean);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40"
      >
        <span className="font-mono text-[0.64rem] uppercase tracking-[0.08em] text-slate-400">
          {t(`kindLabel.${item.sourceType}`, { defaultValue: item.sourceType })}
        </span>
        {projectName && (
          <span className="rounded bg-brand-teal/10 px-1.5 py-0.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-brand-teal-ink dark:text-brand-teal">
            {projectName}
          </span>
        )}
        {item.origin && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-slate-500">
            {item.origin.spaceKey ??
              t(`origin.connectorLabel.${item.origin.connectorKind}`, {
                defaultValue: item.origin.connectorKind,
              })}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">
          {item.name ?? t('list.unnamed')}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          {item.origin?.upstreamGone && (
            <Pill tone="warning">
              {ORIGIN_GONE_KEY[item.origin.upstreamGone]
                ? t(ORIGIN_GONE_KEY[item.origin.upstreamGone]!)
                : item.origin.upstreamGone}
            </Pill>
          )}
          {item.factCount > 0 && (
            <span className="text-xs text-slate-500">
              {t('list.factCount', { count: item.factCount })}
            </span>
          )}
          {flags}
        </span>
        <span className="text-xs text-slate-400" title={item.at}>
          {timeAgo(item.at)}
        </span>
      </button>
    </li>
  );
}
