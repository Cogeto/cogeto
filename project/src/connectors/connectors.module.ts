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
import { EmailSourceDeletion } from './email.source-deletion';
import { EmailSourceService } from './email-source.service';
import { EmailSourceController } from './email-source.controller';
import { EmailIntakeController } from './email-intake.controller';
import { EmailSettingsController } from './email-settings.controller';
import { MailIntakeGuard } from './mail-intake.guard';
import { MAIL_OPTIONS } from './mail-options';
import type { MailOptions } from './mail-options';
import { ResearchController } from './research.controller';
import { ResearchService } from './research.service';
import { RESEARCH_OPTIONS } from './research-options';
import type { ResearchOptions } from './research-options';
import { WebDiscoveryService } from './web-discovery.service';
import { WebFetchService } from './web-fetch';
import { WebSourceReader } from './web.source-reader';
import { WebSourceDeletion } from './web.source-deletion';

export interface ConnectorsModuleOptions {
  /** File-upload knobs from validated config (default 25 MB, §A.9 short TTL). */
  fileUpload: FileUploadOptions;
  /** Inbound-email knobs from validated config (Session O4, decision 0028). */
  mail: MailOptions;
  /** Web-research knobs from validated config (Priority 5 Part A, 0042/0043). */
  research: ResearchOptions;
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
        EmailSourceController,
        ResearchController,
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
        EmailSourceDeletion,
        EmailSourceService,
        MailIntakeGuard,
        ResearchService,
        WebDiscoveryService,
        WebFetchService,
        WebSourceReader,
        WebSourceDeletion,
        { provide: FILE_UPLOAD_OPTIONS, useValue: options.fileUpload },
        { provide: MAIL_OPTIONS, useValue: options.mail },
        { provide: RESEARCH_OPTIONS, useValue: options.research },
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
        EmailSourceDeletion,
        EmailSourceService,
        ResearchService,
        WebSourceReader,
        WebSourceDeletion,
      ],
    };
  }
}
