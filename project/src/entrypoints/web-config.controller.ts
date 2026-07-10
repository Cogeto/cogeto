import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import type { WebConfig } from '@cogeto/shared';
import { COGETO_CONFIG } from './config';
import type { CogetoConfig } from './config';

/**
 * GET /api/config — OIDC parameters for the SPA. The client id is created by
 * the zitadel-init bootstrap job (§A.2) and written to a shared volume file;
 * unauthenticated by design (the SPA needs it before login).
 */
@Controller('config')
export class WebConfigController {
  constructor(@Inject(COGETO_CONFIG) private readonly config: CogetoConfig) {}

  @Get()
  async webConfig(): Promise<WebConfig> {
    let base: WebConfig;
    try {
      const raw = await readFile(this.config.webConfigFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<WebConfig>;
      if (!parsed.clientId || !parsed.issuer) {
        throw new Error('web config file is missing issuer or clientId');
      }
      base = { issuer: parsed.issuer, clientId: parsed.clientId };
    } catch {
      throw new ServiceUnavailableException(
        'identity bootstrap has not completed yet (web config unavailable)',
      );
    }
    // Ana sandbox (decision 0022): a demo instance advertises demoMode and its
    // pre-minted session. The signal is the demo session file the demo-seed job
    // writes — so `docker compose --profile demo up` flips the SPA into sandbox
    // mode with no extra env (an explicit COGETO_DEMO_MODE=1 forces it too). A
    // production instance never serves it, and a customer instance never has the
    // file (it mounts an empty demo-config volume).
    if (this.config.production) return base;
    const demoSession = await this.readDemoSession();
    if (!this.config.demoMode && !demoSession) return base;
    return { ...base, demoMode: true, ...(demoSession ? { demoSession } : {}) };
  }

  private async readDemoSession(): Promise<{ accessToken: string } | null> {
    try {
      const raw = await readFile(this.config.demoSessionFile, 'utf8');
      const parsed = JSON.parse(raw) as { accessToken?: unknown };
      return typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0
        ? { accessToken: parsed.accessToken }
        : null;
    } catch {
      // Seed has not run yet — the SPA falls back to the login screen.
      return null;
    }
  }
}
