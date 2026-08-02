import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { HealthCheck } from '@cogeto/shared';
import { fetchHealth } from '../api';
import type { Session } from '../auth/oidc';
import { Card, ErrorState, Pill, SectionTitle, SkeletonRows } from './ui';

function CheckRow({ name, check }: { name: string; check: HealthCheck }) {
  const { t } = useTranslation('system');
  return (
    <li className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2">
      <span className="text-sm font-medium text-slate-700">{name}</span>
      <span className="flex items-center gap-2 text-sm">
        {check.detail && <span className="text-xs text-slate-400">{check.detail}</span>}
        <span className="text-slate-400">{t('health.latency', { ms: check.latencyMs })}</span>
        {check.ok ? (
          <Pill tone="positive" icon="●">
            {t('health.up')}
          </Pill>
        ) : (
          <span title={check.error}>
            <Pill tone="danger" icon="●">
              {t('health.down')}
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
  const { t } = useTranslation('system');
  const { data, isPending, isError } = useQuery({
    queryKey: ['health'],
    queryFn: () => fetchHealth(session),
    refetchInterval: 10_000,
  });

  return (
    <Card>
      <div className="mb-3">
        <SectionTitle>{t('health.heading')}</SectionTitle>
      </div>
      {isPending && <SkeletonRows rows={4} label={t('health.loading')} />}
      {isError && <ErrorState>{t('health.unreachable')}</ErrorState>}
      {data && (
        <ul className="space-y-2">
          {/* PostgreSQL, Qdrant and MinIO are product names and stay verbatim in
              every locale; the checks named after what they verify are translated. */}
          <CheckRow name="PostgreSQL" check={data.checks.postgres} />
          <CheckRow name="Qdrant" check={data.checks.qdrant} />
          <CheckRow name="MinIO" check={data.checks.minio} />
          <CheckRow name={t('health.check.minioEncryption')} check={data.checks.minioEncryption} />
          <CheckRow name={t('health.check.integrity')} check={data.checks.integrity} />
          <CheckRow name={t('health.check.migrations')} check={data.checks.migrations} />
          <CheckRow name={t('health.check.queue')} check={data.checks.queue} />
        </ul>
      )}
    </Card>
  );
}
