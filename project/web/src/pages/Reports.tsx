import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { FindingsReportDto, ImportRunDto, ReportScopeDto } from '@cogeto/shared';
import {
  fetchImports,
  fetchProjects,
  fetchReportDownload,
  fetchReports,
  triggerReport,
} from '../api';
import type { Session } from '../auth/oidc';
import { formatDateTime, formatNumber } from '../i18n/format';
import { Shell } from '../components/Shell';
import {
  btnPrimary,
  btnSecondary,
  Card,
  EmptyState,
  ErrorState,
  Pill,
  SectionTitle,
  SkeletonRows,
} from '../components/ui';
import { useApiErrorMessage } from '../i18n/api-error';

/**
 * Reports (V2.3 item 6.2): the findings-run surface. A run examines a stated
 * scope, the worker generates the signed artifacts (PDF for the reader, JSON
 * for machines), and this page triggers, shows honest progress, and hands out
 * the short-lived download URLs. An expired run says why it is gone.
 */

type ScopeKind = 'corpus' | 'import' | 'date_range' | 'project';

function StatusPill({ report }: { report: FindingsReportDto }) {
  const { t } = useTranslation('reports');
  if (report.status === 'ready')
    return (
      <Pill tone="positive" icon="✓">
        {t('status.ready')}
      </Pill>
    );
  if (report.status === 'failed') return <Pill tone="danger">{t('status.failed')}</Pill>;
  if (report.status === 'expired') return <Pill tone="neutral">{t('status.expired')}</Pill>;
  return (
    <Pill tone="warning" className="animate-pulse">
      {report.status === 'running' && report.progress
        ? t(`status.stage.${report.progress.stage}`)
        : t('status.pending')}
    </Pill>
  );
}

function DeltaLine({ report }: { report: FindingsReportDto }) {
  const { t } = useTranslation('reports');
  const counts = report.counts;
  if (!counts) return null;
  if (counts.resolvedSincePrevious === null) {
    return <p className="text-xs text-slate-500">{t('delta.firstRun')}</p>;
  }
  return (
    <p className="text-xs text-slate-500">
      {t('delta.sincePrevious', {
        resolved: formatNumber(counts.resolvedSincePrevious),
        appeared: formatNumber(counts.newSincePrevious ?? 0),
        reopened: formatNumber(counts.reopenedSincePrevious ?? 0),
      })}
    </p>
  );
}

function ReportRow({ session, report }: { session: Session; report: FindingsReportDto }) {
  const { t } = useTranslation('reports');
  const apiError = useApiErrorMessage(t);
  const [error, setError] = useState<string | null>(null);
  const download = useMutation({
    mutationFn: async (format: 'pdf' | 'json') => {
      const { url } = await fetchReportDownload(session, report.id, format);
      window.location.href = url;
    },
    onError: (err: Error) => setError(apiError(err)),
  });
  const counts = report.counts;
  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{t(`scope.${report.scope.kind}`)}</div>
          <div className="text-xs text-slate-500">
            {formatDateTime(report.createdAt)} · {report.modelConfigId ?? ''}
          </div>
        </div>
        <StatusPill report={report} />
      </div>
      {report.status === 'running' && report.progress && report.progress.total > 0 ? (
        <p className="text-xs text-slate-500">
          {t('progress.assembling', {
            done: formatNumber(report.progress.done),
            total: formatNumber(report.progress.total),
          })}
        </p>
      ) : null}
      {counts ? (
        <p className="text-sm text-slate-600">
          {t('countsLine', {
            sources: formatNumber(counts.sourcesExamined),
            facts: formatNumber(counts.facts),
            open: formatNumber(counts.findingsOpen),
            withheld: formatNumber(counts.suppressedFacts),
            notFullyRead: formatNumber(counts.sourcesUnreadable + counts.sourcesTruncated),
          })}
        </p>
      ) : null}
      <DeltaLine report={report} />
      {report.status === 'ready' ? (
        <div className="flex gap-2">
          <button
            type="button"
            className={btnPrimary}
            onClick={() => download.mutate('pdf')}
            disabled={download.isPending}
          >
            {t('download.pdf')}
          </button>
          <button
            type="button"
            className={btnSecondary}
            onClick={() => download.mutate('json')}
            disabled={download.isPending}
          >
            {t('download.json')}
          </button>
        </div>
      ) : null}
      {report.status === 'expired' ? (
        <p className="text-xs text-slate-500">{t('expiredNote')}</p>
      ) : null}
      {report.status === 'failed' && report.error ? (
        <p className="text-xs text-red-600">{report.error}</p>
      ) : null}
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </Card>
  );
}

function TriggerCard({ session }: { session: Session }) {
  const { t } = useTranslation('reports');
  const apiError = useApiErrorMessage(t);
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ScopeKind>('corpus');
  const [importRunId, setImportRunId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const imports = useQuery({
    queryKey: ['imports'],
    queryFn: () => fetchImports(session),
    enabled: kind === 'import',
  });
  // A report FOR a project (V2.5 item 8.3 issue C2): the run enumerates that
  // project's sources and nothing else, so a client-facing report cannot
  // carry another client's documents.
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => fetchProjects(session),
  });
  const trigger = useMutation({
    mutationFn: (scope: ReportScopeDto) => triggerReport(session, scope),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (err: Error) => setError(apiError(err)),
  });

  const submit = () => {
    if (kind === 'import') {
      if (!importRunId) return;
      trigger.mutate({ kind: 'import', importRunId });
      return;
    }
    if (kind === 'project') {
      if (!projectId) return;
      trigger.mutate({ kind: 'project', projectId });
      return;
    }
    if (kind === 'date_range') {
      if (!from || !to) return;
      trigger.mutate({
        kind: 'date_range',
        from: new Date(from).toISOString(),
        to: new Date(`${to}T23:59:59.999Z`).toISOString(),
      });
      return;
    }
    trigger.mutate({ kind: 'corpus' });
  };

  const selectClass = 'rounded border border-slate-300 px-2 py-1.5 text-sm bg-white';
  return (
    <Card className="space-y-3">
      <SectionTitle>{t('trigger.title')}</SectionTitle>
      <p className="text-sm text-slate-600">{t('trigger.explainer')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-slate-600" htmlFor="report-scope">
          {t('trigger.scopeLabel')}
        </label>
        <select
          id="report-scope"
          className={selectClass}
          value={kind}
          onChange={(event) => setKind(event.target.value as ScopeKind)}
        >
          <option value="corpus">{t('scope.corpus')}</option>
          <option value="import">{t('scope.import')}</option>
          <option value="date_range">{t('scope.date_range')}</option>
          {(projects.data ?? []).length > 0 && (
            <option value="project">{t('scope.project')}</option>
          )}
        </select>
        {kind === 'project' ? (
          <select
            className={selectClass}
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            aria-label={t('trigger.projectLabel')}
          >
            <option value="">{t('trigger.projectPlaceholder')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        ) : null}
        {kind === 'import' ? (
          <select
            className={selectClass}
            value={importRunId}
            onChange={(event) => setImportRunId(event.target.value)}
            aria-label={t('trigger.importLabel')}
          >
            <option value="">{t('trigger.importPlaceholder')}</option>
            {(imports.data ?? []).map((run: ImportRunDto) => (
              <option key={run.id} value={run.id}>
                {formatDateTime(run.createdAt)}
              </option>
            ))}
          </select>
        ) : null}
        {kind === 'date_range' ? (
          <>
            <input
              type="date"
              className={selectClass}
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              aria-label={t('trigger.fromLabel')}
            />
            <input
              type="date"
              className={selectClass}
              value={to}
              onChange={(event) => setTo(event.target.value)}
              aria-label={t('trigger.toLabel')}
            />
          </>
        ) : null}
        <button type="button" className={btnPrimary} onClick={submit} disabled={trigger.isPending}>
          {t('trigger.button')}
        </button>
      </div>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </Card>
  );
}

export function Reports({ session }: { session: Session }) {
  const { t } = useTranslation('reports');
  const apiError = useApiErrorMessage(t);
  const reports = useQuery({
    queryKey: ['reports'],
    queryFn: () => fetchReports(session),
    refetchInterval: (query) =>
      query.state.data?.some((row) => row.status === 'pending' || row.status === 'running')
        ? 2000
        : false,
  });

  return (
    <Shell session={session} title={t('title')} active="reports">
      <div className="space-y-4">
        <TriggerCard session={session} />
        <SectionTitle>{t('list.title')}</SectionTitle>
        {reports.isLoading ? <SkeletonRows rows={3} /> : null}
        {reports.isError ? <ErrorState>{apiError(reports.error)}</ErrorState> : null}
        {reports.data && reports.data.length === 0 ? (
          <EmptyState title={t('list.emptyTitle')}>{t('list.emptyHint')}</EmptyState>
        ) : null}
        {(reports.data ?? []).map((report) => (
          <ReportRow key={report.id} session={session} report={report} />
        ))}
      </div>
    </Shell>
  );
}
