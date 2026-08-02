import { useQuery } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import type { DashboardStatsDto, MemoryStatus } from '@cogeto/shared';
import { fetchDashboardStats } from '../api';
import type { Session } from '../auth/oidc';
import { statusLabel } from './status';
import { Card, ErrorState, SectionTitle, SkeletonRows } from './ui';
import { donutArcs, seriesSummary, seriesTotal, sparklinePoints } from './charts';

/**
 * The dashboard statistics: real, gated numbers a
 * professional wants at a glance — memory by status, sources over
 * time, dreaming activity, and the oldest unresolved review item — each
 * deep-linking to the filtered view behind it. Hand-rolled SVG charts (no
 * charting dependency); every chart carries a text equivalent and never encodes
 * meaning by color alone.
 */

/** Status → donut hue. AA legend labels carry the meaning; color only assists.
 * Hues are theme-aware CSS tokens (--chart-*, defined in index.css, re-derived
 * for the dark surface) rather than baked hex, so the charts read in both themes. */
const STATUS_COLOR: Record<MemoryStatus, string> = {
  active: 'var(--chart-active)',
  user_approved: 'var(--chart-approved)',
  uncertain: 'var(--chart-uncertain)',
  contradicted: 'var(--chart-contradicted)',
  outdated: 'var(--chart-outdated)',
  replaced: 'var(--chart-replaced)',
};
const STATUS_ORDER: MemoryStatus[] = [
  'active',
  'user_approved',
  'uncertain',
  'contradicted',
  'outdated',
  'replaced',
];

export function StatsPanel({ session }: { session: Session }) {
  const { t } = useTranslation('dashboard');
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => fetchDashboardStats(session),
  });

  if (isPending) {
    return (
      <Card>
        <div className="mb-3">
          <SectionTitle>{t('stats.heading')}</SectionTitle>
        </div>
        <SkeletonRows rows={4} label={t('stats.loading')} />
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <div className="mb-3">
          <SectionTitle>{t('stats.heading')}</SectionTitle>
        </div>
        <ErrorState onRetry={() => void refetch()}>{t('stats.error')}</ErrorState>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <KpiRow data={data} />
      <div className="grid gap-4 md:grid-cols-2">
        <MemoryDonut data={data} />
        <SourcesSpark data={data} />
        <DreamingSpark data={data} />
      </div>
    </div>
  );
}

// ── KPI tiles ─────────────────────────────────────────────────────────────────

function KpiRow({ data }: { data: DashboardStatsDto }) {
  const { t } = useTranslation('dashboard');
  const oldestDays =
    data.review.oldestAt === null
      ? null
      : Math.max(
          0,
          Math.round((Date.now() - new Date(data.review.oldestAt).getTime()) / 86_400_000),
        );
  const tiles = [
    { key: 'memories', label: t('stats.kpi.memories'), value: data.memoryTotal, href: '/memories' },
    { key: 'openLoops', label: t('stats.kpi.stillOpen'), value: data.openLoops, href: '/' },
    {
      key: 'contradictions',
      label: t('stats.kpi.contradictions'),
      value: data.review.contradicted,
      href: '/review',
    },
    {
      key: 'approvals',
      label: t('stats.kpi.approvals'),
      value: data.approvalsPending,
      href: '/approvals',
    },
    {
      key: 'oldestConflict',
      label: t('stats.kpi.oldestConflict'),
      value:
        oldestDays === null
          ? t('stats.kpi.oldestNone')
          : t('stats.kpi.oldestDays', { days: oldestDays }),
      href: '/review',
      title:
        oldestDays === null
          ? t('stats.kpi.oldestTitleNone')
          : t('stats.kpi.oldestTitle', { count: oldestDays }),
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((tile) => (
        <a
          key={tile.key}
          href={tile.href}
          title={tile.title}
          className="rounded-lg border border-slate-200 bg-surface p-3 shadow-sm transition-colors hover:border-brand-teal/50"
        >
          <div className="text-2xl font-semibold tabular-nums text-slate-800">{tile.value}</div>
          <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-slate-500">
            {tile.label}
          </div>
        </a>
      ))}
    </div>
  );
}

// ── Memory by status (donut) ──────────────────────────────────────────────────

function MemoryDonut({ data }: { data: DashboardStatsDto }) {
  const { t } = useTranslation('dashboard');
  const R = 42;
  const C = 2 * Math.PI * R;
  const segments = STATUS_ORDER.map((s) => ({ key: s, value: data.memoryByStatus[s] })).filter(
    (s) => s.value > 0,
  );
  const arcs = donutArcs(segments, C);
  // One sentence, one key: the per-status counts are a joined LIST interpolated
  // into it, so word order stays the translator's to choose.
  const summary =
    data.memoryTotal === 0
      ? t('stats.donut.summaryEmpty')
      : t('stats.donut.summary', {
          count: data.memoryTotal,
          breakdown: segments
            .map((s) => t('stats.donut.segment', { count: s.value, status: statusLabel(s.key) }))
            .join(', '),
        });

  return (
    <Card>
      <div className="mb-3">
        <SectionTitle as="h3">{t('stats.donut.heading')}</SectionTitle>
      </div>
      {data.memoryTotal === 0 ? (
        <p className="text-sm text-slate-500">{t('stats.donut.empty')}</p>
      ) : (
        <div className="flex items-center gap-5">
          <svg viewBox="0 0 100 100" className="h-28 w-28 shrink-0" role="img" aria-label={summary}>
            <circle
              cx="50"
              cy="50"
              r={R}
              fill="none"
              stroke="var(--chart-track)"
              strokeWidth="10"
            />
            {arcs.map((a) => (
              <circle
                key={a.key}
                cx="50"
                cy="50"
                r={R}
                fill="none"
                stroke={STATUS_COLOR[a.key as MemoryStatus]}
                strokeWidth="10"
                strokeDasharray={a.dashArray}
                strokeDashoffset={a.dashOffset}
                transform="rotate(-90 50 50)"
              />
            ))}
            <text
              x="50"
              y="47"
              textAnchor="middle"
              className="fill-slate-800"
              style={{ fontSize: '18px', fontWeight: 600 }}
            >
              {data.memoryTotal}
            </text>
            <text
              x="50"
              y="60"
              textAnchor="middle"
              className="fill-slate-400"
              style={{ fontSize: '7px' }}
            >
              {t('stats.donut.unit')}
            </text>
          </svg>
          <ul className="min-w-0 flex-1 space-y-1">
            {segments.map((s) => (
              <li key={s.key}>
                <a
                  href={`/memories?status=${s.key}`}
                  className="flex items-center gap-2 text-sm text-slate-600 hover:text-brand-teal-ink dark:hover:text-brand-teal"
                >
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: STATUS_COLOR[s.key as MemoryStatus] }}
                  />
                  <span className="flex-1 truncate">{statusLabel(s.key)}</span>
                  <span className="font-semibold tabular-nums text-slate-800">{s.value}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ── Sources over time (sparkline) ─────────────────────────────────────────────

function SourcesSpark({ data }: { data: DashboardStatsDto }) {
  const { t } = useTranslation('dashboard');
  const totals = data.sources.series.map((d) =>
    data.sources.keys.reduce((sum, k) => sum + (d.counts[k] ?? 0), 0),
  );
  const grand = totals.reduce((a, b) => a + b, 0);
  return (
    <Card>
      <div className="mb-1 flex items-center justify-between">
        <SectionTitle as="h3">{t('stats.sources.heading', { days: 30 })}</SectionTitle>
        <a
          href="/memories"
          className="text-xs font-semibold text-brand-teal-ink dark:text-brand-teal hover:underline"
        >
          {t('stats.sources.ingested', { count: grand })}
        </a>
      </div>
      <Spark values={totals} color="var(--chart-active)" label={seriesSummary(data.sources)} />
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        {data.sources.keys.map((k) => (
          <li key={k}>
            <Trans
              i18nKey="stats.sources.familyTotal"
              ns="dashboard"
              count={seriesTotal(data.sources, k)}
              values={{ count: seriesTotal(data.sources, k), family: k }}
              components={{ n: <span className="font-semibold text-slate-700" /> }}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── Dreaming activity (sparkline) ─────────────────────────────────────────────

function DreamingSpark({ data }: { data: DashboardStatsDto }) {
  const { t } = useTranslation('dashboard');
  const merges = data.dreaming.series.map((d) => d.counts.merges ?? 0);
  const conflicts = data.dreaming.series.map((d) => d.counts.conflicts ?? 0);
  return (
    <Card>
      <div className="mb-1">
        <SectionTitle as="h3">{t('stats.dreaming.heading', { days: 30 })}</SectionTitle>
      </div>
      <p className="sr-only">{seriesSummary(data.dreaming)}</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Spark
            values={merges}
            color="var(--chart-approved)"
            label={t('stats.dreaming.mergesLabel', { count: seriesTotal(data.dreaming, 'merges') })}
          />
          <p className="mt-1 text-xs text-slate-500">
            <Trans
              i18nKey="stats.dreaming.merges"
              ns="dashboard"
              count={seriesTotal(data.dreaming, 'merges')}
              values={{ count: seriesTotal(data.dreaming, 'merges') }}
              components={{ n: <span className="font-semibold text-slate-700" /> }}
            />
          </p>
        </div>
        <div>
          <Spark
            values={conflicts}
            color="var(--chart-contradicted)"
            label={t('stats.dreaming.conflictsLabel', {
              count: seriesTotal(data.dreaming, 'conflicts'),
            })}
          />
          <a
            href="/review?tab=contradicted"
            className="mt-1 block text-xs text-slate-500 hover:text-brand-teal-ink dark:hover:text-brand-teal"
          >
            <Trans
              i18nKey="stats.dreaming.conflicts"
              ns="dashboard"
              count={seriesTotal(data.dreaming, 'conflicts')}
              values={{ count: seriesTotal(data.dreaming, 'conflicts') }}
              components={{ n: <span className="font-semibold text-slate-700" /> }}
            />
          </a>
        </div>
      </div>
    </Card>
  );
}

function Spark({ values, color, label }: { values: number[]; color: string; label: string }) {
  const W = 200;
  const H = 36;
  const points = sparklinePoints(values, W, H, 2);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-9 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
