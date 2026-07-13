import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IDENTITY_OPTIONS } from './identity-options';
import type { IdentityOptions } from './identity-options';
import { IdentityService } from './identity.service';
import { BearerAuthGuard } from './bearer-auth.guard';
import { AdminGuard } from './admin.guard';
import { MeController } from './me.controller';
import { PRINCIPAL, principalProvider } from './principal.provider';
import { UserDirectory } from './user-directory';

/**
 * identity — leaf seam wrapping Zitadel (scope §4.5, §A.10). Zitadel answers
 * "who is this user and what org/roles do they have"; memory scoping stays
 * Cogeto logic. No other module calls Zitadel. Options come from the
 * composition root — the seam reads no environment itself.
 */
@Module({})
export class IdentityModule {
  static register(options: IdentityOptions): DynamicModule {
    return {
      module: IdentityModule,
      // Global like DatabaseModule: domain-module controllers resolve
      // BearerAuthGuard without each module re-registering the seam's options.
      global: true,
      controllers: [MeController],
      providers: [
        { provide: IDENTITY_OPTIONS, useValue: options },
        IdentityService,
        UserDirectory,
        BearerAuthGuard,
        AdminGuard,
        principalProvider,
      ],
      // IDENTITY_OPTIONS is exported (not just provided) so that AdminGuard —
      // applied via @UseGuards on a controller in ANOTHER module (the app root's
      // JobsController, QS-10) — can have its @Inject(IDENTITY_OPTIONS) resolved
      // from that module's injector. Without this the app fails to boot: "Nest
      // can't resolve dependencies of the AdminGuard". (BearerAuthGuard escapes
      // this only because its dep, IdentityService, is already exported.)
      exports: [
        IDENTITY_OPTIONS,
        IdentityService,
        UserDirectory,
        BearerAuthGuard,
        AdminGuard,
        PRINCIPAL,
      ],
    };
  }
}
