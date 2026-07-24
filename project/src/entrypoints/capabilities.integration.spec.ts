import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import type { IntegritySweep, MemoryObjectStore } from '../memory/index';
import type { ModelGateway } from '../model-gateway/index';
import { CapabilitiesService } from './capabilities';
import { HealthController } from './health.controller';
import type { CogetoConfig } from './config';

/**
 * The capability registry against real Postgres (P6.7, decision 0055):
 *
 *   health_additive — /api/health keeps its existing `checks` contract
 *     byte-for-byte (the operator script and the status panel iterate it) and
 *     gains the additive capability/job fields.
 *   jobs_overdue (real SQL) — the dreaming state is read from the actual
 *     dream_run table: a stale finished run flips it to overdue.
 *
 * External probes point at unroutable local ports; only Postgres is real.
 */

const quietIntegrity = {
  status: async () => ({ lastSweepAt: null, lastReport: null, openAlerts: 0 }),
} as unknown as IntegritySweep;

function config(databaseUrl: string): CogetoConfig {
  return {
    databaseUrl,
    qdrantUrl: 'http://127.0.0.1:9',
    s3Url: 'http://127.0.0.1:9',
    redactionEnabled: false,
    redactionUrl: undefined,
    composeProfiles: [],
    researchEnabled: false,
    consolesEnabled: false,
    searxngUrl: undefined,
    demoMode: false,
    production: false,
    jobsOverdueHours: 26,
    modelProviders: { configured: false, ollama: null },
  } as unknown as CogetoConfig;
}

describe('capability registry (integration, real Postgres)', () => {
  let tdb: TestDatabase;
  let controller: HealthController;

  beforeAll(async () => {
    tdb = await startTestDatabase();
  }, 120_000);

  afterAll(async () => {
    // The controller opens its own small pool (as it does in the app process).
    await controller?.['pool'].end();
    await tdb.stop();
  });

  const buildService = (): CapabilitiesService =>
    new CapabilitiesService(config(tdb.container.getConnectionUri()), tdb.db, quietIntegrity);

  it('health_additive: the existing checks contract is untouched and the new fields are present', async () => {
    controller = new HealthController(
      config(tdb.container.getConnectionUri()),
      { encryptionEnabled: async () => true } as unknown as MemoryObjectStore,
      quietIntegrity,
      { reachable: async () => ({ ok: true, detail: 'stub' }) } as unknown as ModelGateway,
      buildService(),
    );
    const report = await controller.health();

    // The pre-P6.7 consumers (operator script, status panel) iterate exactly
    // these keys — additive means they never change.
    expect(Object.keys(report.checks)).toEqual([
      'postgres',
      'qdrant',
      'minio',
      'minioEncryption',
      'integrity',
      'migrations',
      'queue',
      'gateway',
      'mail',
    ]);
    expect(report.checks.postgres.ok).toBe(true);
    expect(report.checks.migrations.ok).toBe(true);

    // The additive capability/job surface.
    expect(report.capabilities.map((c) => c.id)).toEqual([
      'redaction',
      'research',
      'demo',
      'consoles',
      'local-models',
    ]);
    expect(report.jobs.map((j) => j.id)).toEqual(['dreaming', 'sweep']);
    // A fresh instance (migrations just applied) is not overdue: never-ran
    // nightly jobs stay quiet inside the first threshold window.
    expect(report.jobs.every((j) => j.state === 'ok')).toBe(true);
  });

  it('jobs_overdue: a stale finished dream_run flips dreaming to overdue through the real table', async () => {
    const staleFinish = new Date(Date.now() - 27 * 3_600_000);
    await tdb.pool.query(
      `INSERT INTO dream_run (started_at, finished_at, scope_from, scope_to, counts_json)
       VALUES ($1, $1, $1, $1, '{"merged": 5, "contradictions": 1}'::jsonb)`,
      [staleFinish],
    );

    const stale = await buildService().snapshot();
    const dreaming = stale.jobs.find((j) => j.id === 'dreaming')!;
    expect(dreaming.state).toBe('overdue');
    expect(dreaming.lastRunAt).toBe(staleFinish.toISOString());
    expect(dreaming.lastResult).toContain('5 merged');

    // A fresh finished run recovers it (new service instance: the snapshot
    // cache is per-instance and 20 s long).
    const recentFinish = new Date(Date.now() - 3_600_000);
    await tdb.pool.query(
      `INSERT INTO dream_run (started_at, finished_at, scope_from, scope_to, counts_json)
       VALUES ($1, $1, $1, $1, '{"merged": 0}'::jsonb)`,
      [recentFinish],
    );
    const recovered = await buildService().snapshot();
    expect(recovered.jobs.find((j) => j.id === 'dreaming')!.state).toBe('ok');
  });
});
