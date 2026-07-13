import { Controller, Get, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BearerAuthGuard } from './bearer-auth.guard';
import { IdentityService } from './identity.service';
import { Public } from './public.decorator';

/**
 * QS-18 — default-deny auth. The bearer guard is registered GLOBALLY (APP_GUARD),
 * so a brand-new controller that forgets `@UseGuards` is CLOSED, not silently
 * open; only `@Public()` opts out. This spins up a real Nest app (no new deps —
 * @nestjs/core + platform-express only) with one undecorated controller and one
 * @Public() controller, and asserts the undecorated route is denied by default.
 */

// A newly-added controller that forgets any guard decorator — must be denied.
@Controller('probe')
class UndecoratedController {
  @Get()
  get(): { ok: true } {
    return { ok: true };
  }
}

// The intentional opt-out — must be reachable without a token.
@Public()
@Controller('open')
class PublicController {
  @Get()
  get(): { ok: true } {
    return { ok: true };
  }
}

// The identity service must never be consulted for the public route, and for the
// undecorated route the guard rejects before ever calling it (no bearer header).
const identityStub = {
  resolvePrincipal: () => {
    throw new Error('resolvePrincipal must not be reached in this test');
  },
} as unknown as IdentityService;

@Module({
  controllers: [UndecoratedController, PublicController],
  providers: [
    { provide: IdentityService, useValue: identityStub },
    // Explicit factory wiring (not the bare class): vitest's esbuild transform
    // does not emit decorator metadata, so Nest cannot reflect the guard's
    // constructor — inject Reflector + IdentityService by token instead.
    {
      provide: BearerAuthGuard,
      useFactory: (identity: IdentityService, reflector: Reflector) =>
        new BearerAuthGuard(identity, reflector),
      inject: [IdentityService, Reflector],
    },
    { provide: APP_GUARD, useExisting: BearerAuthGuard },
  ],
})
class TestModule {}

describe('QS-18 — global bearer guard is default-deny', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0); // ephemeral port
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('denies an undecorated controller route with 401 by default', async () => {
    const res = await fetch(`${baseUrl}/probe`);
    expect(res.status).toBe(401);
  });

  it('allows a route explicitly marked @Public()', async () => {
    const res = await fetch(`${baseUrl}/open`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
