import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { SpaceService } from './space.service';
import { SpacesController } from './spaces.controller';

/**
 * spaces (docs/features/spaces.md): the sealed-partition records and the
 * data-and-API surface for this session. A leaf domain context: it owns
 * `space` and `user_space_state`, imports no other domain module, and decides
 * nothing about visibility. The wall itself is the `space_id` gate dimension
 * inside the memory module's queries and the vector payload pre-filter; the
 * per-request space rides the Principal, resolved at the identity seam.
 */
@Module({})
export class SpacesModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: SpacesModule,
      imports: [...(options.imports ?? [])],
      controllers: [SpacesController],
      providers: [SpaceService],
      exports: [SpaceService],
    };
  }
}
