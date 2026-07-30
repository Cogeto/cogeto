import { describe, expect, it } from 'vitest';
import type { HealthReport } from '@cogeto/shared';
import { isLoopbackRequest, redactHealthReport } from './health-access.guard';
import type { HealthRequest } from './health-access.guard';

/**
 * health_access (audit 2.0 SEC-3): the aggregate report stopped being public.
 * These cover the two pure halves of the fix — who counts as "inside the
 * container", and what a caller without the admin role is allowed to see. The
 * guard's bearer branch is exercised end to end by the app's integration specs.
 */

const request = (remoteAddress: string | undefined): HealthRequest =>
  ({ socket: { remoteAddress } }) as unknown as HealthRequest;

describe('health_access: loopback detection', () => {
  it('accepts every loopback form the Node stack produces', () => {
    expect(isLoopbackRequest(request('127.0.0.1'))).toBe(true);
    expect(isLoopbackRequest(request('::1'))).toBe(true);
    expect(isLoopbackRequest(request('::ffff:127.0.0.1'))).toBe(true);
  });

  it('rejects the compose bridge, the public internet, and a missing peer', () => {
    // Caddy reaches the app over the bridge network — NOT loopback, so a
    // request arriving through the edge always has to authenticate.
    expect(isLoopbackRequest(request('172.18.0.5'))).toBe(false);
    expect(isLoopbackRequest(request('10.0.0.7'))).toBe(false);
    expect(isLoopbackRequest(request('203.0.113.9'))).toBe(false);
    expect(isLoopbackRequest(request(undefined))).toBe(false);
  });

  it('cannot be spoofed by a forwarded header (the socket is the only source)', () => {
    const spoofed = {
      socket: { remoteAddress: '203.0.113.9' },
      headers: { 'x-forwarded-for': '127.0.0.1' },
    } as unknown as HealthRequest;
    expect(isLoopbackRequest(spoofed)).toBe(false);
  });
});

const full: HealthReport = {
  status: 'degraded',
  capabilities: [
    {
      id: 'research',
      state: 'unreachable',
      probed: true,
      checkedAt: '2026-07-30T10:00:00.000Z',
      error: 'SearXNG unreachable at http://searxng:8080 (connect ECONNREFUSED)',
      detail: 'SearXNG healthy; web discovery available',
    },
  ],
  jobs: [
    {
      id: 'sweep',
      state: 'overdue',
      lastRunAt: '2026-07-28T03:00:00.000Z',
      lastResult: '12 receipts checked, 0 alerts',
      overdueAfterHours: 26,
      checkedAt: '2026-07-30T10:00:00.000Z',
      error: 'no successful run since 2026-07-28T03:00:00.000Z',
    },
  ],
  checks: {
    postgres: { ok: false, latencyMs: 12, error: 'connect ECONNREFUSED 172.18.0.2:5432' },
    qdrant: { ok: true, latencyMs: 3 },
    minio: { ok: true, latencyMs: 4 },
    minioEncryption: { ok: true, latencyMs: 5, detail: 'SSE-S3 default encryption on' },
    integrity: { ok: true, latencyMs: 6, detail: 'last sweep 2026-07-28; 0 alert(s)' },
    migrations: { ok: true, latencyMs: 7, detail: '36 migrations applied' },
    queue: {
      ok: false,
      latencyMs: 8,
      depth: 41,
      deadLettered: 3,
      permanentlyFailed: 1,
      detail: '41 queued, 3 dead-lettered, 1 permanently failed',
      error: '3 dead-lettered job(s); 1 permanently-failed job(s)',
    },
    gateway: { ok: true, latencyMs: 9 },
    mail: { ok: true, latencyMs: 10, detail: 'SMTP mail:2525 reachable' },
  },
};

describe('health_access: the redacted report', () => {
  const redacted = redactHealthReport(full);
  const serialized = JSON.stringify(redacted);

  it('keeps every verdict, so the dashboard status panel is unchanged', () => {
    expect(redacted.status).toBe('degraded');
    expect(redacted.checks.postgres.ok).toBe(false);
    expect(redacted.checks.qdrant.ok).toBe(true);
    expect(redacted.checks.queue.ok).toBe(false);
    expect(redacted.checks.postgres.latencyMs).toBe(12);
    expect(redacted.capabilities[0]!.state).toBe('unreachable');
    expect(redacted.jobs[0]!.state).toBe('overdue');
    expect(redacted.jobs[0]!.lastRunAt).toBe('2026-07-28T03:00:00.000Z');
    // The shape stays whole: every check the panel indexes is still present.
    expect(Object.keys(redacted.checks).sort()).toEqual(Object.keys(full.checks).sort());
  });

  it('drops every error string and probe detail', () => {
    for (const check of Object.values(redacted.checks)) {
      expect(check.error).toBeUndefined();
      expect(check.detail).toBeUndefined();
    }
    expect(redacted.capabilities[0]!.error).toBeUndefined();
    expect(redacted.capabilities[0]!.detail).toBeUndefined();
    expect(redacted.jobs[0]!.error).toBeUndefined();
    expect(redacted.jobs[0]!.lastResult).toBeNull();
  });

  it('leaks no internal hostname, port or upstream error fragment', () => {
    for (const marker of [
      'searxng',
      'ECONNREFUSED',
      '172.18.0.2',
      '5432',
      'mail:2525',
      'dead-lettered',
    ]) {
      expect(serialized).not.toContain(marker);
    }
  });

  it('zeroes the queue backlog — an anonymous read of it is a timing oracle', () => {
    expect(redacted.checks.queue.depth).toBe(0);
    expect(redacted.checks.queue.deadLettered).toBe(0);
    expect(redacted.checks.queue.permanentlyFailed).toBe(0);
  });

  it('does not mutate the report handed to an administrator', () => {
    expect(full.checks.postgres.error).toBe('connect ECONNREFUSED 172.18.0.2:5432');
    expect(full.checks.queue.depth).toBe(41);
    expect(full.jobs[0]!.lastResult).toBe('12 receipts checked, 0 alerts');
  });
});
