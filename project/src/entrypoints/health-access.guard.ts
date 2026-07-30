import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { HealthCheck, HealthReport } from '@cogeto/shared';
import { IdentityService } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { COGETO_CONFIG } from './config';
import type { CogetoConfig } from './config';

/**
 * The request as this guard leaves it: the principal when one authenticated,
 * plus whether the caller may see the report's operational detail. `principal`
 * is optional because the loopback path has none.
 */
export interface HealthRequest extends Request {
  principal?: AuthenticatedRequest['principal'];
  /** Set by {@link HealthAccessGuard}: full detail vs the redacted report. */
  healthDetail?: boolean;
}

/**
 * Access control for the aggregate health report (audit 2.0 SEC-3). The report
 * carries operational internals — queue and dead-letter depths, migration
 * state, the receipt-chain verdict, internal service URLs and upstream error
 * strings — so it must never answer an anonymous internet caller, which it did
 * while `@Public()` sat on the whole controller instead of on `live()`.
 *
 * Three callers are legitimate, and each gets exactly what it needs:
 *
 * 1. **A process inside the app container** (loopback). `scripts/operator/cogeto`
 *    runs `compose exec -T app node -e 'fetch("http://127.0.0.1:3000/api/health")'`
 *    for `status` and `features`; it holds no token and cannot obtain one. A
 *    loopback peer address is a sound proof of "already inside the app
 *    container": Caddy reaches the app over the compose bridge (a 172.x source),
 *    the fetcher refuses loopback targets outright, and anything that can open a
 *    loopback socket here already has code execution in this process's
 *    container. Full detail.
 * 2. **An authenticated administrator.** Full detail.
 * 3. **Any other authenticated user.** The Dashboard's status panel renders for
 *    every user, so the route stays available to them — but trimmed by
 *    {@link redactHealthReport}: booleans and coarse state, no error strings and
 *    no internal URLs.
 *
 * Anyone else gets 401. The controller is marked `@Public()` so the global
 * bearer guard defers to this one; authentication still happens here, and
 * `request.principal` is attached exactly as the global guard would.
 */
@Injectable()
export class HealthAccessGuard implements CanActivate {
  constructor(
    private readonly identity: IdentityService,
    @Inject(COGETO_CONFIG) private readonly config: CogetoConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HealthRequest>();
    if (isLoopbackRequest(request)) {
      request.healthDetail = true;
      return true;
    }

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }
    request.principal = await this.identity.resolvePrincipal(header.slice('Bearer '.length));
    request.healthDetail = request.principal.roles.includes(this.config.adminRole);
    return true;
  }
}

/**
 * True when the request's TCP peer is the loopback interface. Read from the
 * socket, never from a forwarded header: `X-Forwarded-For` is attacker-supplied
 * and the app trusts no proxy headers anywhere.
 */
export function isLoopbackRequest(request: Request): boolean {
  const address = request.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * The report as a caller without the admin role may see it (SEC-3). Every
 * verdict is preserved — `status`, each check's `ok` and `latencyMs`, each
 * capability's `state`, each job's `state` and `lastRunAt` — so the Dashboard
 * status panel renders exactly as before. What goes is the operational prose:
 *
 * - `error` on checks, capabilities and jobs: these carry upstream `pg`
 *   connection fragments and probe failures naming internal hosts.
 * - `detail` on checks and capabilities: `capabilities.ts` interpolates
 *   `COGETO_REDACTION_URL` / `COGETO_SEARXNG_URL` verbatim into it.
 * - `lastResult` on jobs: free-form run summaries.
 * - the queue's `depth` / `deadLettered` / `permanentlyFailed`: an anonymous
 *   read of the backlog is an attack-timing oracle. `ok` still says whether
 *   work was lost.
 */
export function redactHealthReport(report: HealthReport): HealthReport {
  const check = <T extends HealthCheck>(c: T): T => {
    const { error: _error, detail: _detail, ...rest } = c;
    return rest as T;
  };
  const queue = check(report.checks.queue);
  return {
    status: report.status,
    capabilities: report.capabilities.map((c) => ({
      id: c.id,
      state: c.state,
      probed: c.probed,
      checkedAt: c.checkedAt,
    })),
    jobs: report.jobs.map((j) => ({
      id: j.id,
      state: j.state,
      lastRunAt: j.lastRunAt,
      lastResult: null,
      overdueAfterHours: j.overdueAfterHours,
      checkedAt: j.checkedAt,
    })),
    checks: {
      postgres: check(report.checks.postgres),
      qdrant: check(report.checks.qdrant),
      minio: check(report.checks.minio),
      minioEncryption: check(report.checks.minioEncryption),
      integrity: check(report.checks.integrity),
      migrations: check(report.checks.migrations),
      queue: { ...queue, depth: 0, deadLettered: 0, permanentlyFailed: 0 },
      gateway: check(report.checks.gateway),
      mail: check(report.checks.mail),
    },
  };
}
