import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { NotesSourceReader } from './notes.source-reader';
import { NotesSourceDeletion } from './notes.source-deletion';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { FileSourceReader } from './file.source-reader';
import { SettingsController } from './settings.controller';
import { UserSettingsService } from './user-settings.service';
import { FILE_UPLOAD_OPTIONS } from './file-upload-options';
import type { FileUploadOptions } from './file-upload-options';
import { EmailIntakeService } from './email-intake.service';
import { EmailAllowlistService } from './email-allowlist.service';
import { EmailSourceReader } from './email.source-reader';
import { EmailIntakeController } from './email-intake.controller';
import { EmailSettingsController } from './email-settings.controller';
import { MailIntakeGuard } from './mail-intake.guard';
import { MAIL_OPTIONS } from './mail-options';
import type { MailOptions } from './mail-options';

export interface ConnectorsModuleOptions {
  /** File-upload knobs from validated config (default 25 MB, §A.9 short TTL). */
  fileUpload: FileUploadOptions;
  /** Inbound-email knobs from validated config (Session O4, decision 0028). */
  mail: MailOptions;
}

/**
 * connectors — notes, files, then email (§A.11; decision 0003 ruling 4). S2-A
 * shipped notes; O1 added the file source; O4 adds email — a per-tenant,
 * receive-only Haraka SMTP server feeding the SAME pipeline (source_type
 * 'email'). Registered once per process and marked global so the source readers
 * / deletions it exports resolve into ingestion and memory without those modules
 * re-importing it.
 *
 * File + email bytes are the memory module's (decision 0003 ruling 2): the
 * connectors sources reach them only through the memory module's public ports
 * (MemoryObjectStore, MemoryFileStore).
 */
@Module({})
export class ConnectorsModule {
  static register(options: ConnectorsModuleOptions): DynamicModule {
    return {
      module: ConnectorsModule,
      global: true,
      controllers: [
        NotesController,
        FilesController,
        SettingsController,
        EmailIntakeController,
        EmailSettingsController,
      ],
      providers: [
        NotesService,
        NotesSourceReader,
        NotesSourceDeletion,
        FilesService,
        FileSourceReader,
        UserSettingsService,
        EmailIntakeService,
        EmailAllowlistService,
        EmailSourceReader,
        MailIntakeGuard,
        { provide: FILE_UPLOAD_OPTIONS, useValue: options.fileUpload },
        { provide: MAIL_OPTIONS, useValue: options.mail },
      ],
      exports: [
        NotesService,
        NotesSourceReader,
        NotesSourceDeletion,
        FilesService,
        FileSourceReader,
        UserSettingsService,
        EmailIntakeService,
        EmailAllowlistService,
        EmailSourceReader,
      ],
    };
  }
}
