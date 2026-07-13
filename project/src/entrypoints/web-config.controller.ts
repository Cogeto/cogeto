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
    // Ana sandbox (decision 0022) — FAIL-CLOSED (QS-3). Serving the pre-minted
    // demo session (a working bearer token, published to anyone) requires an
    // EXPLICIT COGETO_DEMO_MODE=1. File presence alone NEVER flips it: a stray
    // session.json in a reused demo-config volume can no longer hand a token to
    // an anonymous caller. Production is refused first; a customer instance
    // (demo unset, production unset) serves nothing but the base OIDC config.
    if (this.config.production || !this.config.demoMode) return base;
    const demoSession = await this.readDemoSession();
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
