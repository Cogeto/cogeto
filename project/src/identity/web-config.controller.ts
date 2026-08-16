import { Body, Controller, Get, Inject, Optional, Post, Req } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { WebConfig } from '@cogeto/shared';
import { Public } from './public.decorator';
import { WEB_CONFIG_OPTIONS } from './identity-options';
import type { WebConfigOptions } from './identity-options';
import { readDemoLogin } from './demo-login';
import { InMemoryRateLimitStore, RateLimitStore, userError } from '../infrastructure/index';

const demoLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * The demo-login wall (issue #636): attempts per client per window.
 *
 * Fixed constants rather than plumbed configuration. This gates ONE credential
 * pair on a disposable sandbox instance, so there is nothing an operator would
 * ever want to tune, and a knob in `.env` for it would be a variable to
 * explain in a file whose whole point is that an operator owns about six of
 * them.
 *
 * Ten in five minutes is far above what a person fumbling a pasted password
 * needs and far below what makes an online guess worth attempting against a
 * generated secret.
 */
const DEMO_LOGIN_MAX_PER_WINDOW = 10;
const DEMO_LOGIN_WINDOW_MS = 5 * 60 * 1000;

/**
 * GET /api/config — OIDC parameters for the SPA (unauthenticated by design — the
 * SPA needs them before login; @Public). POST /api/config/demo-login — the
 * password gate for the Ana sandbox: the operator exchanges the
 * generated username + password for the demo session token. The token is NEVER
 * served on GET /api/config anymore — the sandbox is no longer auto-open.
 *
 * Lives in the identity seam (V2.0 item 3.6 part 2): both routes are the login
 * bootstrap — what the SPA must know before it can authenticate, and the one
 * credential exchange that mints a session. It sits beside `/api/me`.
 */
@Public()
@Controller('config')
export class WebConfigController {
  private readonly limiter: RateLimitStore;

  constructor(
    @Inject(WEB_CONFIG_OPTIONS) private readonly config: WebConfigOptions,
    // Falls back to an in-process window for bare constructions (tests, the
    // worker root's own wiring), the pattern every other limiter site uses.
    @Optional() limiter?: RateLimitStore,
  ) {
    this.limiter = limiter ?? new InMemoryRateLimitStore();
  }

  @Get()
  async webConfig(): Promise<WebConfig> {
    const base = await this.readBaseConfig();
    // Ana sandbox — FAIL-CLOSED. Production or a
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
  async demoLogin(
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<{ accessToken: string }> {
    // Only a demo, non-production instance can exchange credentials for a
    // session — mirror the GET fail-closed gate so a customer/production
    // instance exposes nothing (existence is not leaked: same 401 either way).
    if (this.config.production || !this.config.demoMode) {
      throw userError.unauthorized('auth.demoUnavailable', 'demo login is not available');
    }

    // The wall (issue #636). This is the only public credential exchange in
    // the product and it had no limit at all: the generated password is long
    // and random, so an online guess was never the likely way in, but "the
    // secret is strong" is a property of today's generator and not a control.
    // Counted BEFORE the comparison, so a wrong password costs the same as a
    // right one and the count cannot be avoided by any input.
    const { count, resetAt } = await this.limiter.hit(
      clientKey(request),
      'demo_login',
      DEMO_LOGIN_WINDOW_MS,
      Date.now(),
    );
    if (count > DEMO_LOGIN_MAX_PER_WINDOW) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      throw userError.tooManyRequests(
        'limit.rateLimited',
        'rate limit reached for {{bucket}}, retry in {{seconds}}s',
        { bucket: 'demo_login', seconds: retryAfter },
        { retryAfterSeconds: retryAfter },
      );
    }

    const parsed = demoLoginSchema.safeParse(body);
    if (!parsed.success)
      throw userError.unauthorized('auth.invalidCredentials', 'invalid username or password');

    const creds = await readDemoLogin(this.config.demoSessionFile);
    const token = await this.readDemoToken();
    if (!creds || !token) {
      throw userError.unauthorized(
        'auth.demoInitializing',
        'the demo sandbox is still initializing',
      );
    }
    // Constant-time comparison so a wrong password cannot be timed out char by
    // char. The generated password is long/random, so this is belt-and-braces.
    const ok =
      safeEqual(parsed.data.username, creds.username) &&
      safeEqual(parsed.data.password, creds.password);
    if (!ok)
      throw userError.unauthorized('auth.invalidCredentials', 'invalid username or password');
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
      throw userError.unavailable(
        'auth.identityBootstrapping',
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

/**
 * The rate-limit key for an unauthenticated caller (issue #636).
 *
 * The app never faces the internet directly: Caddy is the only thing in front
 * of it, so the socket's peer address is always Caddy's compose-bridge IP and
 * keying on it would put every visitor in one bucket — a wall an attacker
 * could use to lock the sandbox's real users out.
 *
 * `X-Forwarded-For` is set by Caddy's `reverse_proxy`, which APPENDS the peer
 * it observed to whatever the client sent. So the LAST element is Caddy's own
 * observation and is trustworthy; every earlier element is client-supplied and
 * forgeable, which is why this reads the last and never the first. With no
 * header at all (a direct call inside the compose network) it falls back to
 * the socket address, which is the shared bucket and the safe direction.
 */
function clientKey(request: Request): string {
  const header = request.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[header.length - 1] : header;
  const hops = (raw ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  const observed = hops[hops.length - 1];
  return observed ?? request.socket?.remoteAddress ?? 'unknown';
}

/** Length-guarded constant-time string compare. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
