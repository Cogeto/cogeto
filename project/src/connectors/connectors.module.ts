import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { NotesSourceReader } from './notes.source-reader';
import { NotesSourceDeletion } from './notes.source-deletion';

/**
 * connectors — notes, calendar, email, in that order (§A.11; decision 0003
 * ruling 4: OAuth callbacks/webhooks in app; all sync as worker jobs; tokens
 * encrypted at callback, decrypted only in the worker). S2-A ships the notes
 * source: capture endpoint + the ingestion pipeline's source reader.
 */
@Module({
  controllers: [NotesController],
  providers: [NotesService, NotesSourceReader, NotesSourceDeletion],
  exports: [NotesService, NotesSourceReader, NotesSourceDeletion],
})
export class ConnectorsModule {}
