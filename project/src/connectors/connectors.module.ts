import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { UserContextModule } from '../infrastructure/index';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { NotesSourceReader } from './notes.source-reader';
import { NotesSourceDeletion } from './notes.source-deletion';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { FileSourceReader } from './file.source-reader';
import { SettingsController } from './settings.controller';
import { UserSettingsService } from './user-settings.service';
import { UserContextController } from './user-context.controller';
import { ContextSuggestionsService } from './context-suggestions.service';
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
import { ResearchConclusionService } from './research-conclude';
import { RESEARCH_OPTIONS } from './research-options';
import type { ResearchOptions } from './research-options';
import { WebDiscoveryService } from './web-discovery.service';
import { WebFetchService } from './web-fetch';
import { WebSourceReader } from './web.source-reader';
import { WebSourceDeletion } from './web.source-deletion';
import { SkillRunService } from './skills/skill-run.service';
import { SKILL_ENGINE_OPTIONS, SkillEngine } from './skills/skill-engine';
import type { SkillEngineOptions } from './skills/skill-engine';
import {
  DEFAULT_INSTANCE_TIMEZONE,
  INSTANCE_TIMEZONE,
  UserContextService,
} from '../infrastructure/index';

export interface ConnectorsModuleOptions {
  /** File-upload knobs from validated config (default 25 MB, short TTL). */
  fileUpload: FileUploadOptions;
  /** Inbound-email knobs from validated config. */
  mail: MailOptions;
  /** Web-research knobs from validated config (0042/0043). */
  research: ResearchOptions;
}

/**
 * connectors — notes, files, then email.
 * shipped notes; O1 added the file source; O4 adds email — a per-tenant,
 * receive-only Haraka SMTP server feeding the SAME pipeline (source_type
 * 'email'). Registered once per process and marked global so the source readers
 * / deletions it exports resolve into ingestion and memory without those modules
 * re-importing it.
 *
 * File + email bytes are the memory module's: the
 * connectors sources reach them only through the memory module's public ports
 * (MemoryObjectStore, MemoryFileStore).
 */
@Module({})
export class ConnectorsModule {
  static register(options: ConnectorsModuleOptions): DynamicModule {
    return {
      module: ConnectorsModule,
      // RECORDED EXCEPTION B14 (docs/module-boundary-contract.md): a global
      // DOMAIN module, which the boundary policy does not allow. Its source
      // readers and deletion adapters reach ingestion and memory through
      // globality instead of the registration options that exist for exactly
      // that. Un-globaling means threading one dynamic-module reference through
      // IngestionModule, MemoryModule and three sub-modules, which is the
      // composition V2.0 item 3.6 part 3 rewrites when connectors/ splits.
      global: true,
      // UserContextModule: the settings surface, the context-suggestion
      // service and the skill engine. Explicit since it stopped being global.
      imports: [UserContextModule],
      controllers: [
        NotesController,
        FilesController,
        SettingsController,
        UserContextController,
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
        ContextSuggestionsService,
        EmailIntakeService,
        EmailAllowlistService,
        EmailSourceReader,
        EmailSourceDeletion,
        EmailSourceService,
        MailIntakeGuard,
        ResearchService,
        ResearchConclusionService,
        WebDiscoveryService,
        WebFetchService,
        WebSourceReader,
        WebSourceDeletion,
        // Named skills: the run record + the
        // engine live in BOTH roots (the app approves plans, the worker
        // advances); the planner + controller are app-only (SkillsModule).
        SkillRunService,
        SkillEngine,
        // The engine's optional collaborators, by TOKEN into a named bag
        // (V2.0 item 3.6 part 4): identity, never position.
        {
          provide: SKILL_ENGINE_OPTIONS,
          useFactory: (
            userContext?: UserContextService,
            timeZone?: string,
          ): SkillEngineOptions => ({
            userContext,
            instanceTimeZone: timeZone ?? DEFAULT_INSTANCE_TIMEZONE,
          }),
          inject: [
            { token: UserContextService, optional: true },
            { token: INSTANCE_TIMEZONE, optional: true },
          ],
        },
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
        ResearchConclusionService,
        WebSourceReader,
        WebSourceDeletion,
        SkillRunService,
        SkillEngine,
      ],
    };
  }
}
