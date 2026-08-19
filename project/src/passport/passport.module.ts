import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';
import { PassportController } from './passport.controller';
import { PassportService } from './passport.service';
import { PassportExportStore } from './passport.store';
import { PassportExportExecutor } from './passport-export.executor';
import { PASSPORT_OPTIONS } from './passport.options';
import type { PassportOptions } from './passport.options';
import { SPACE_NAME_RESOLVER } from './space-name.port';
import type { SpaceNameResolver } from './space-name.port';

/**
 * passport — the Memory Passport (spec §11.4): a complete, documented,
 * versioned export of a user's own data. It composes the memory module's gated
 * reads + object store (like retrieval composes them),
 * owns only its request/status ledger, and signs the manifest with the instance
 * key in the worker. Every read is Principal-gated: a user exports only what
 * they may see.
 */
@Module({})
export class PassportModule {
  static register(
    options: PassportOptions & {
      imports?: ModuleMetadata['imports'];
      /** The spaces module's name lookup for the per-space manifest, bound by
       * the composition root (the ProjectPolicySource precedent). Absent, the
       * manifest carries `name: null` and the space id stays the identity. */
      spaceNames?: Type<SpaceNameResolver>;
    },
  ): DynamicModule {
    return {
      module: PassportModule,
      // The memory module instance (B13 closed): the gated reads and stores
      // resolve from an explicit import, never globality.
      imports: [...(options.imports ?? [])],
      controllers: [PassportController],
      providers: [
        { provide: PASSPORT_OPTIONS, useValue: options },
        ...(options.spaceNames
          ? [{ provide: SPACE_NAME_RESOLVER, useExisting: options.spaceNames }]
          : []),
        PassportService,
        PassportExportStore,
        PassportExportExecutor,
      ],
      exports: [PassportExportExecutor, PassportExportStore],
    };
  }
}
