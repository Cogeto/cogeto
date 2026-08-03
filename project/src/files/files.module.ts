import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { FileSourceReader } from './file.source-reader';
import { FileReadReportCascade } from './file-read-report.cascade';
import { FileReadReportStore } from './persistence/file-read-report';
import { FILE_UPLOAD_OPTIONS } from './file-upload-options';
import type { FileUploadOptions } from './file-upload-options';

/**
 * files — document upload (V2.0 item 3.6 part 4, split out of the connectors
 * context): stored or extract-and-discard documents entering the pipeline as
 * source_type 'file'. Since V2.1 item 4.1 that means PDF, DOCX, XLSX and CSV,
 * each a registered reader behind the seam in `./reading/`.
 *
 * A file source's row is still the memory module's `file_metadata`, keyed by
 * object key and reached only through memory's public ports. The one table this
 * module owns is `file_read_report` (migration 0041): what the reading layer
 * made of the bytes, which has no home on a metadata row that discard-mode
 * uploads never have. NOT global: the roots thread the reader through
 * ingestion's registration options.
 */
@Module({})
export class FilesModule {
  static register(options: {
    fileUpload: FileUploadOptions;
    imports?: ModuleMetadata['imports'];
  }): DynamicModule {
    return {
      module: FilesModule,
      // The memory and settings instances (B13): stored bytes go through
      // memory's ports; uploads apply the user's default scope + discard flag.
      imports: [...(options.imports ?? [])],
      controllers: [FilesController],
      providers: [
        FilesService,
        FileSourceReader,
        FileReadReportStore,
        FileReadReportCascade,
        { provide: FILE_UPLOAD_OPTIONS, useValue: options.fileUpload },
      ],
      exports: [FilesService, FileSourceReader, FileReadReportCascade, FILE_UPLOAD_OPTIONS],
    };
  }
}

/**
 * The read-report deletion cascade, bound into the memory saga's
 * `derivedCascades`. Kept in its OWN module, like the suppressed-fact and
 * reply-draft cascades before it: it depends on nothing but its own table
 * access, so the memory module can import it without a cycle back through the
 * file upload path (which imports memory).
 */
@Module({
  providers: [FileReadReportStore, FileReadReportCascade],
  exports: [FileReadReportStore, FileReadReportCascade],
})
export class FileReadReportCascadeModule {}
