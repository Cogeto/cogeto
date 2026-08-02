import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { NotesSourceReader } from './notes.source-reader';
import { NotesSourceDeletion } from './notes.source-deletion';

/**
 * notes — the simplest capture surface (V2.0 item 3.6 part 4, split out of
 * the connectors context): typed notes become `note` rows and enter the SAME
 * pipeline as every other source (source_type 'user_note'). NOT global: the
 * composition roots thread the reader and deletion adapters through
 * ingestion's and memory's registration options, per the boundary contract.
 */
@Module({})
export class NotesModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: NotesModule,
      // The settings instance: capture applies the user's default scope.
      imports: [...(options.imports ?? [])],
      controllers: [NotesController],
      providers: [NotesService, NotesSourceReader, NotesSourceDeletion],
      exports: [NotesService, NotesSourceReader, NotesSourceDeletion],
    };
  }
}
