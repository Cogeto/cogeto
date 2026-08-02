import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { FileSourceReader } from './file.source-reader';
import { FILE_UPLOAD_OPTIONS } from './file-upload-options';
import type { FileUploadOptions } from './file-upload-options';

/**
 * files — document upload (V2.0 item 3.6 part 4, split out of the connectors
 * context): stored or extract-and-discard PDFs/DOCX entering the pipeline as
 * source_type 'file'. Owns NO tables: a file source's row is the memory
 * module's file_metadata, keyed by object key, reached only through memory's
 * public ports. NOT global: the roots thread the reader through ingestion's
 * registration options.
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
        { provide: FILE_UPLOAD_OPTIONS, useValue: options.fileUpload },
      ],
      exports: [FilesService, FileSourceReader, FILE_UPLOAD_OPTIONS],
    };
  }
}
