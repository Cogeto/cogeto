import { useQuery } from '@tanstack/react-query';
import type { HealthCheck } from '@cogeto/shared';
import { fetchHealth } from '../api';

function CheckRow({ name, check }: { name: string; check: HealthCheck }) {
  return (
    <li className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2">
      <span className="text-sm font-medium text-slate-700">{name}</span>
      <span className="flex items-center gap-2 text-sm">
        {check.detail && <span className="text-xs text-slate-400">{check.detail}</span>}
        <span className="text-slate-400">{check.latencyMs} ms</span>
        {check.ok ? (
          <span className="rounded-full bg-brand-teal/15 px-2 py-0.5 text-xs font-semibold text-brand-teal">
            up
          </span>
        ) : (
          <span
            className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-600"
            title={check.error}
          >
            down
          </span>
        )}
      </span>
    </li>
  );
}

/** System status panel: GET /api/health (Postgres, Qdrant, MinIO reachability). */
export function StatusPanel() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
  });

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        System status
      </h2>
      {isPending && <p className="text-sm text-slate-400">Checking…</p>}
      {isError && <p className="text-sm text-red-600">The API is unreachable.</p>}
      {data && (
        <ul className="space-y-2">
          <CheckRow name="PostgreSQL" check={data.checks.postgres} />
          <CheckRow name="Qdrant" check={data.checks.qdrant} />
          <CheckRow name="MinIO" check={data.checks.minio} />
          <CheckRow name="Migrations" check={data.checks.migrations} />
          <CheckRow name="Job queue" check={data.checks.queue} />
        </ul>
      )}
    </section>
  );
}
