import { useQuery } from '@tanstack/react-query';
import type { HealthCheck } from '@cogeto/shared';
import { fetchHealth } from '../api';
import type { Session } from '../auth/oidc';
import { Card, ErrorState, Pill, SectionTitle, SkeletonRows } from './ui';

function CheckRow({ name, check }: { name: string; check: HealthCheck }) {
  return (
    <li className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2">
      <span className="text-sm font-medium text-slate-700">{name}</span>
      <span className="flex items-center gap-2 text-sm">
        {check.detail && <span className="text-xs text-slate-400">{check.detail}</span>}
        <span className="text-slate-400">{check.latencyMs} ms</span>
        {check.ok ? (
          <Pill tone="positive" icon="●">
            up
          </Pill>
        ) : (
          <span title={check.error}>
            <Pill tone="danger" icon="●">
              down
            </Pill>
          </span>
        )}
      </span>
    </li>
  );
}

/** System status panel: GET /api/health (Postgres, Qdrant, MinIO reachability).
 * Authenticated since SEC-3; an administrator additionally sees each check's
 * `detail`/`error`, everyone else the same up/down verdicts. */
export function StatusPanel({ session }: { session: Session }) {
  const { data, isPending, isError } = useQuery({
    queryKey: ['health'],
    queryFn: () => fetchHealth(session),
    refetchInterval: 10_000,
  });

  return (
    <Card>
      <div className="mb-3">
        <SectionTitle>System status</SectionTitle>
      </div>
      {isPending && <SkeletonRows rows={4} label="Checking services…" />}
      {isError && <ErrorState>The API is unreachable right now.</ErrorState>}
      {data && (
        <ul className="space-y-2">
          <CheckRow name="PostgreSQL" check={data.checks.postgres} />
          <CheckRow name="Qdrant" check={data.checks.qdrant} />
          <CheckRow name="MinIO" check={data.checks.minio} />
          <CheckRow name="MinIO encryption" check={data.checks.minioEncryption} />
          <CheckRow name="Deletion integrity" check={data.checks.integrity} />
          <CheckRow name="Migrations" check={data.checks.migrations} />
          <CheckRow name="Job queue" check={data.checks.queue} />
        </ul>
      )}
    </Card>
  );
}
