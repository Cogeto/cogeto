import { useQuery } from '@tanstack/react-query';
import type { DashboardStatsDto, MemoryStatus } from '@cogeto/shared';
import { fetchDashboardStats } from '../api';
import type { Session } from '../auth/oidc';
import { statusLabel } from './status';
import { Card, ErrorState, SectionTitle, SkeletonRows } from './ui';
import { donutArcs, seriesSummary, seriesTotal, sparklinePoints } from './charts';

/**
 * The dashboard statistics (Post-v1 Priority 2): real, gated numbers a
 * professional wants at a glance — memory by status, task load, sources over
 * time, dreaming activity, and the oldest unresolved review item — each
 * deep-linking to the filtered view behind it. Hand-rolled SVG charts (no
 * charting dependency); every chart carries a text equivalent and never encodes
 * meaning by color alone.
 */

/** Status → donut hue. AA legend labels carry the meaning; color only assists. */
const STATUS_COLOR: Record<MemoryStatus, string> = {
  active: '#21c29a',
  user_approved: '#0b6b57',
  uncertain: '#d97706',
  contradicted: '#dc2626',
  outdated: '#64748b',
  replaced: '#94a3b8',
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
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => fetchDashboardStats(session),
  });

  if (isPending) {
    return (
      <Card>
        <div className="mb-3">
          <SectionTitle>Your practice at a glance</SectionTitle>
        </div>
        <SkeletonRows rows={4} label="Loading statistics…" />
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <div className="mb-3">
          <SectionTitle>Your practice at a glance</SectionTitle>
        </div>
        <ErrorState onRetry={() => void refetch()}>
          The statistics aren&apos;t available right now.
        </ErrorState>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <KpiRow data={data} />
      <div className="grid gap-4 md:grid-cols-2">
        <MemoryDonut data={data} />
        <TaskLoad data={data} />
        <SourcesSpark data={data} />
        <DreamingSpark data={data} />
      </div>
    </div>
  );
}

// ── KPI tiles ─────────────────────────────────────────────────────────────────

function KpiRow({ data }: { data: DashboardStatsDto }) {
  const oldestDays =
    data.review.oldestAt === null
      ? null
      : Math.max(
          0,
          Math.round((Date.now() - new Date(data.review.oldestAt).getTime()) / 86_400_000),
        );
  const tiles = [
    { label: 'Memories', value: data.memoryTotal, href: '/memories' },
    { label: 'Open tasks', value: data.tasks.open + data.tasks.blocked, href: '/tasks' },
    {
      label: 'To review',
      value: data.review.uncertain + data.review.contradicted,
      href: '/review',
    },
    { label: 'Approvals', value: data.approvalsPending, href: '/approvals' },
    {
      label: 'Oldest review',
      value: oldestDays === null ? '—' : `${oldestDays}d`,
      href: '/review',
      title:
        oldestDays === null
          ? 'No unresolved review items'
          : `Oldest unresolved review item: ${oldestDays} day${oldestDays === 1 ? '' : 's'} old`,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((t) => (
        <a
          key={t.label}
          href={t.href}
          title={t.title}
          className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition-colors hover:border-brand-teal/50"
        >
          <div className="text-2xl font-semibold tabular-nums text-slate-800">{t.value}</div>
          <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-slate-500">
            {t.label}
          </div>
        </a>
      ))}
    </div>
  );
}

// ── Memory by status (donut) ──────────────────────────────────────────────────

function MemoryDonut({ data }: { data: DashboardStatsDto }) {
  const R = 42;
  const C = 2 * Math.PI * R;
  const segments = STATUS_ORDER.map((s) => ({ key: s, value: data.memoryByStatus[s] })).filter(
    (s) => s.value > 0,
  );
  const arcs = donutArcs(segments, C);
  const summary =
    data.memoryTotal === 0
      ? 'No memories yet.'
      : `${data.memoryTotal} memories: ` +
        segments.map((s) => `${s.value} ${statusLabel(s.key)}`).join(', ') +
        '.';

  return (
    <Card>
      <div className="mb-3">
        <SectionTitle as="h3">Memory by status</SectionTitle>
      </div>
      {data.memoryTotal === 0 ? (
        <p className="text-sm text-slate-500">
          Nothing captured yet. As you add notes, emails and files, they&apos;ll appear here by
          status.
        </p>
      ) : (
        <div className="flex items-center gap-5">
          <svg viewBox="0 0 100 100" className="h-28 w-28 shrink-0" role="img" aria-label={summary}>
            <circle cx="50" cy="50" r={R} fill="none" stroke="#e2e8f0" strokeWidth="10" />
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
              memories
            </text>
          </svg>
          <ul className="min-w-0 flex-1 space-y-1">
            {segments.map((s) => (
              <li key={s.key}>
                <a
                  href={`/memories?status=${s.key}`}
                  className="flex items-center gap-2 text-sm text-slate-600 hover:text-brand-teal-ink"
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

// ── Task load (compact bars) ──────────────────────────────────────────────────

function TaskLoad({ data }: { data: DashboardStatsDto }) {
  const rows = [
    { label: 'Open', value: data.tasks.open, color: '#21c29a' },
    { label: 'Blocked', value: data.tasks.blocked, color: '#d97706' },
    { label: 'Done', value: data.tasks.done, color: '#64748b' },
  ];
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <SectionTitle as="h3">Task load</SectionTitle>
        <a href="/tasks" className="text-xs font-semibold text-brand-teal-ink hover:underline">
          Open tasks →
        </a>
      </div>
      <ul className="space-y-2.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-xs font-medium text-slate-500">{r.label}</span>
            <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
              <span
                className="block h-full rounded-full"
                style={{ width: `${(r.value / max) * 100}%`, backgroundColor: r.color }}
              />
            </span>
            <span className="w-6 shrink-0 text-right text-sm font-semibold tabular-nums text-slate-800">
              {r.value}
            </span>
          </li>
        ))}
      </ul>
      {data.tasks.dismissed > 0 && (
        <p className="mt-2 text-xs text-slate-400">{data.tasks.dismissed} dismissed</p>
      )}
    </Card>
  );
}

// ── Sources over time (sparkline) ─────────────────────────────────────────────

function SourcesSpark({ data }: { data: DashboardStatsDto }) {
  const totals = data.sources.series.map((d) =>
    data.sources.keys.reduce((sum, k) => sum + (d.counts[k] ?? 0), 0),
  );
  const grand = totals.reduce((a, b) => a + b, 0);
  return (
    <Card>
      <div className="mb-1 flex items-center justify-between">
        <SectionTitle as="h3">Sources · last 30 days</SectionTitle>
        <a href="/memories" className="text-xs font-semibold text-brand-teal-ink hover:underline">
          {grand} ingested →
        </a>
      </div>
      <Spark values={totals} color="#21c29a" label={seriesSummary(data.sources)} />
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        {data.sources.keys.map((k) => (
          <li key={k}>
            <span className="font-semibold text-slate-700">{seriesTotal(data.sources, k)}</span> {k}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── Dreaming activity (sparkline) ─────────────────────────────────────────────

function DreamingSpark({ data }: { data: DashboardStatsDto }) {
  const merges = data.dreaming.series.map((d) => d.counts.merges ?? 0);
  const conflicts = data.dreaming.series.map((d) => d.counts.conflicts ?? 0);
  return (
    <Card>
      <div className="mb-1">
        <SectionTitle as="h3">Dreaming · last 30 days</SectionTitle>
      </div>
      <p className="sr-only">{seriesSummary(data.dreaming)}</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Spark
            values={merges}
            color="#0b6b57"
            label={`Merges: ${seriesTotal(data.dreaming, 'merges')}`}
          />
          <p className="mt-1 text-xs text-slate-500">
            <span className="font-semibold text-slate-700">
              {seriesTotal(data.dreaming, 'merges')}
            </span>{' '}
            merges
          </p>
        </div>
        <div>
          <Spark
            values={conflicts}
            color="#dc2626"
            label={`Conflicts caught: ${seriesTotal(data.dreaming, 'conflicts')}`}
          />
          <a
            href="/review?tab=contradicted"
            className="mt-1 block text-xs text-slate-500 hover:text-brand-teal-ink"
          >
            <span className="font-semibold text-slate-700">
              {seriesTotal(data.dreaming, 'conflicts')}
            </span>{' '}
            conflicts caught →
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
