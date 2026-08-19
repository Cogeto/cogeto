import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';
import { SpaceService } from './space.service';
import { SpacesController } from './spaces.controller';
import { SpaceErasureService } from './space-erasure.service';
import { MachineBindingModule } from './machine-binding.service';
import { SPACE_CLEANUPS } from './space-cleanup.port';
import type { SpaceCleanup } from './space-cleanup.port';

/**
 * spaces (docs/features/spaces.md): the sealed-partition records, the
 * data-and-API surface, and (session 2) space deletion. It owns `space` and
 * `user_space_state` and decides nothing about visibility: the wall itself is
 * the `space_id` gate dimension inside the memory module's queries and the
 * vector payload pre-filter; the per-request space rides the Principal,
 * resolved at the identity seam.
 *
 * Deletion made it a consumer of the memory module's public deletion surface
 * (the saga, the source-deletion adapters, the object store) and the owner of
 * the SpaceCleanup port each container-owning module implements. Both arrive
 * through registration options, threaded by the composition roots exactly
 * like the saga's own collaborators — never resolved globally.
 */
@Module({})
export class SpacesModule {
  static register(
    options: {
      imports?: ModuleMetadata['imports'];
      /** The container cleanups (space deletion): each owning module's
       * implementation, provided by the modules named in `imports`. */
      cleanups?: { imports?: ModuleMetadata['imports']; adapters?: Type<SpaceCleanup>[] };
    } = {},
  ): DynamicModule {
    return {
      module: SpacesModule,
      // MachineBindingModule: the machine-binding management routes
      // (section 6c); the same static module instance also satisfies the
      // identity seam's port, bound by the roots.
      imports: [
        MachineBindingModule,
        ...(options.imports ?? []),
        ...(options.cleanups?.imports ?? []),
      ],
      controllers: [SpacesController],
      providers: [
        SpaceService,
        SpaceErasureService,
        {
          provide: SPACE_CLEANUPS,
          useFactory: (...adapters: SpaceCleanup[]) => adapters,
          inject: options.cleanups?.adapters ?? [],
        },
      ],
      exports: [SpaceService, SpaceErasureService],
    };
  }
}
