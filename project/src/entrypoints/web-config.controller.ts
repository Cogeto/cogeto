import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { WebConfig } from '@cogeto/shared';
import { Public } from '../identity/index';
import { COGETO_CONFIG } from './config';
import type { CogetoConfig } from './config';
import { readDemoLogin } from './demo/credentials';

const demoLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * GET /api/config — OIDC parameters for the SPA (unauthenticated by design — the
 * SPA needs them before login; QS-18 @Public). POST /api/config/demo-login — the
 * password gate for the Ana sandbox (decision 0027): the operator exchanges the
 * generated username + password for the demo session token. The token is NEVER
 * served on GET /api/config anymore — the sandbox is no longer auto-open.
 */
@Public()
@Controller('config')
export class WebConfigController {
  constructor(@Inject(COGETO_CONFIG) private readonly config: CogetoConfig) {}

  @Get()
  async webConfig(): Promise<WebConfig> {
    const base = await this.readBaseConfig();
    // Ana sandbox (decision 0022/0027) — FAIL-CLOSED (QS-3). Production or a
    // non-demo (customer) instance never exposes the sandbox at all. On a demo
    // instance we advertise the PASSWORD-GATED login once the seed has minted
    // credentials + a session; the token itself is not disclosed here.
    if (this.config.production || !this.config.demoMode) return base;
    const ready =
      (await this.readDemoToken()) !== null &&
      (await readDemoLogin(this.config.demoSessionFile)) !== null;
    return { ...base, demoMode: true, ...(ready ? { demoLogin: true } : {}) };
  }

  @Post('demo-login')
  async demoLogin(@Body() body: unknown): Promise<{ accessToken: string }> {
    // Only a demo, non-production instance can exchange credentials for a
    // session — mirror the GET fail-closed gate so a customer/production
    // instance exposes nothing (existence is not leaked: same 401 either way).
    if (this.config.production || !this.config.demoMode) {
      throw new UnauthorizedException('demo login is not available');
    }
    const parsed = demoLoginSchema.safeParse(body);
    if (!parsed.success) throw new UnauthorizedException('invalid username or password');

    const creds = await readDemoLogin(this.config.demoSessionFile);
    const token = await this.readDemoToken();
    if (!creds || !token) {
      throw new UnauthorizedException('the demo sandbox is still initializing');
    }
    // Constant-time comparison so a wrong password cannot be timed out char by
    // char. The generated password is long/random, so this is belt-and-braces.
    const ok =
      safeEqual(parsed.data.username, creds.username) &&
      safeEqual(parsed.data.password, creds.password);
    if (!ok) throw new UnauthorizedException('invalid username or password');
    return { accessToken: token };
  }

  private async readBaseConfig(): Promise<WebConfig> {
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

  /** The demo session token from the seed-written file; null until it exists. */
  private async readDemoToken(): Promise<string | null> {
    try {
      const raw = await readFile(this.config.demoSessionFile, 'utf8');
      const parsed = JSON.parse(raw) as { accessToken?: unknown };
      return typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0
        ? parsed.accessToken
        : null;
    } catch {
      return null;
    }
  }
}

/** Length-guarded constant-time string compare. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
