import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { NotesSourceReader } from './notes.source-reader';
import { NotesSourceDeletion } from './notes.source-deletion';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { FileSourceReader } from './file.source-reader';
import { FILE_UPLOAD_OPTIONS } from './file-upload-options';
import type { FileUploadOptions } from './file-upload-options';

export interface ConnectorsModuleOptions {
  /** File-upload knobs from validated config (default 25 MB, §A.9 short TTL). */
  fileUpload: FileUploadOptions;
}

/**
 * connectors — notes, files, then calendar/email (§A.11; decision 0003 ruling
 * 4). S2-A shipped the notes source; O1 adds the file source (upload + PDF/DOCX
 * extraction into the SAME pipeline). Registered once per process and marked
 * global so the source readers/deletions it exports resolve into ingestion and
 * memory without those modules re-importing it — mirroring the memory seam.
 *
 * File bytes and file_metadata are the memory module's (decision 0003 ruling
 * 2): the file source reaches them only through the memory module's public
 * ports (MemoryObjectStore, MemoryFileStore), which resolve from that global
 * module.
 */
@Module({})
export class ConnectorsModule {
  static register(options: ConnectorsModuleOptions): DynamicModule {
    return {
      module: ConnectorsModule,
      global: true,
      controllers: [NotesController, FilesController],
      providers: [
        NotesService,
        NotesSourceReader,
        NotesSourceDeletion,
        FilesService,
        FileSourceReader,
        { provide: FILE_UPLOAD_OPTIONS, useValue: options.fileUpload },
      ],
      exports: [
        NotesService,
        NotesSourceReader,
        NotesSourceDeletion,
        FilesService,
        FileSourceReader,
      ],
    };
  }
}
