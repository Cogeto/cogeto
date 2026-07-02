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
    try {
      const raw = await readFile(this.config.webConfigFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<WebConfig>;
      if (!parsed.clientId || !parsed.issuer) {
        throw new Error('web config file is missing issuer or clientId');
      }
      return { issuer: parsed.issuer, clientId: parsed.clientId };
    } catch {
      throw new ServiceUnavailableException(
        'identity bootstrap has not completed yet (web config unavailable)',
      );
    }
  }
}
