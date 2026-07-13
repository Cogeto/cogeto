import { describe, expect, it } from 'vitest';
import type { DynamicModule } from '@nestjs/common';
import { IdentityModule } from './identity.module';
import { IDENTITY_OPTIONS } from './identity-options';
import { AdminGuard } from './admin.guard';
import { BearerAuthGuard } from './bearer-auth.guard';

/**
 * App-boot regression (QS-10). AdminGuard is applied via @UseGuards on the app
 * root's JobsController and injects IDENTITY_OPTIONS; if the seam provides but
 * does not EXPORT that token, Nest cannot resolve the guard in the consumer
 * module and the whole app fails to boot ("Nest can't resolve dependencies of
 * the AdminGuard"). This is invisible to unit tests that `new AdminGuard()`
 * directly and to the vitest suite (which never boots the full app), so pin the
 * export here.
 */
describe('IdentityModule DI exports', () => {
  const module = IdentityModule.register({
    internalBaseUrl: 'http://zitadel:8080',
    externalDomain: 'localhost',
    cacheTtlSeconds: 10,
  }) as DynamicModule;

  it('exports IDENTITY_OPTIONS so AdminGuard resolves in a consumer module', () => {
    expect(module.exports).toContain(IDENTITY_OPTIONS);
  });

  it('exports the guards applied by other modules', () => {
    expect(module.exports).toContain(AdminGuard);
    expect(module.exports).toContain(BearerAuthGuard);
  });
});
