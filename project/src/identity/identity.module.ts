import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';
import { IDENTITY_OPTIONS } from './identity-options';
import type { IdentityOptions } from './identity-options';
import { MACHINE_SPACE_BINDINGS } from './machine-space-bindings.port';
import type { MachineSpaceBindings } from './machine-space-bindings.port';
import { IdentityService } from './identity.service';
import { BearerAuthGuard } from './bearer-auth.guard';
import { AdminGuard } from './admin.guard';
import { MeController } from './me.controller';
import { PRINCIPAL, principalProvider } from './principal.provider';
import { UserDirectory } from './user-directory';
import {
  ConnectorCredentialOpener,
  ConnectorCredentialStore,
} from './persistence/connector-credential-store';
import { WebConfigController } from './web-config.controller';
import { WEB_CONFIG_OPTIONS } from './identity-options';

/**
 * identity — leaf seam wrapping Zitadel (scope §4.5, spec §12.1). Zitadel answers
 * "who is this user and what org/roles do they have"; memory scoping stays
 * Cogeto logic. No other module calls Zitadel. Options come from the
 * composition root — the seam reads no environment itself.
 */
@Module({})
export class IdentityModule {
  static register(
    options: IdentityOptions & {
      /**
       * Machine callers' per-credential space bindings
       * (docs/features/spaces.md section 6c): the spaces module implements
       * the lookup, the root binds it here (the port pattern, spec §15
       * rule 2). Absent → every machine principal is refused (fail closed).
       */
      machineBindings?: {
        imports?: ModuleMetadata['imports'];
        adapter?: Type<MachineSpaceBindings>;
      };
    },
  ): DynamicModule {
    const { machineBindings, ...identityOptions } = options;
    return {
      module: IdentityModule,
      imports: [...(machineBindings?.imports ?? [])],
      // Global like DatabaseModule: domain-module controllers resolve
      // BearerAuthGuard without each module re-registering the seam's options.
      global: true,
      // The login bootstrap joins /api/me when this root serves HTTP; the
      // worker leaves `webConfig` unset and registers neither.
      controllers: options.webConfig ? [MeController, WebConfigController] : [MeController],
      providers: [
        { provide: IDENTITY_OPTIONS, useValue: identityOptions },
        ...(options.webConfig
          ? [{ provide: WEB_CONFIG_OPTIONS, useValue: options.webConfig }]
          : []),
        IdentityService,
        UserDirectory,
        BearerAuthGuard,
        AdminGuard,
        principalProvider,
        ConnectorCredentialStore,
        // The decrypting read exists only where the root says so (the
        // worker): a request-path service asking for the opener fails boot
        // instead of reading credentials at runtime (V2.5 item 8.1).
        ...(options.credentialReads ? [ConnectorCredentialOpener] : []),
        // Machine callers' space bindings (section 6c): bound where the root
        // provides an adapter; absent, the guard refuses machine principals.
        ...(machineBindings?.adapter
          ? [{ provide: MACHINE_SPACE_BINDINGS, useExisting: machineBindings.adapter }]
          : []),
      ],
      // IDENTITY_OPTIONS is exported (not just provided) so that AdminGuard —
      // applied via @UseGuards on a controller in ANOTHER module (the app root's
      // JobsController) — can have its @Inject(IDENTITY_OPTIONS) resolved
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
        ConnectorCredentialStore,
        ...(options.credentialReads ? [ConnectorCredentialOpener] : []),
        // Exported for the same reason IDENTITY_OPTIONS is (the comment
        // above): `@UseGuards(BearerAuthGuard)` on a controller in ANOTHER
        // module instantiates the guard in that module's context, and an
        // @Optional dependency that is provided here but not exported
        // silently resolves to undefined there. For the machine-caller rule
        // (docs/features/spaces.md section 6c) that would mean the binding
        // lookup and the demo exemption existed only on identity's own
        // routes, found live by the demo seed refusing its own POST
        // /api/notes while /api/me passed.
        ...(machineBindings?.adapter ? [MACHINE_SPACE_BINDINGS] : []),
        ...(options.webConfig ? [WEB_CONFIG_OPTIONS] : []),
      ],
    };
  }
}
