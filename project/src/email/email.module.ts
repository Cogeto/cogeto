import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { EmailIntakeController } from './email-intake.controller';
import { EmailIntakeService } from './email-intake.service';
import { EmailAllowlistService } from './email-allowlist.service';
import { EmailSourceReader } from './email.source-reader';
import { EmailSourceDeletion } from './email.source-deletion';
import { EmailSourceService } from './email-source.service';
import { EmailSourceController } from './email-source.controller';
import { EmailSettingsController } from './email-settings.controller';
import { MailIntakeGuard } from './mail-intake.guard';
import { MAIL_OPTIONS } from './mail-options';
import type { MailOptions } from './mail-options';

/**
 * email — inbound mail capture (V2.0 item 3.6 part 4, split out of the
 * connectors context): per-tenant receive-only intake feeding the SAME
 * pipeline (source_type 'email'), retained sources, allowlist + refusal
 * ledger. Reply drafting is the separate app-only EmailReplyModule. NOT
 * global: the roots thread the reader and deletion adapters through
 * ingestion's and memory's registration options.
 */
@Module({})
export class EmailModule {
  static register(options: {
    mail: MailOptions;
    imports?: ModuleMetadata['imports'];
  }): DynamicModule {
    return {
      module: EmailModule,
      // The memory and settings instances (B13): retained bytes go through
      // memory's ports; intake applies each recipient's default capture scope.
      imports: [...(options.imports ?? [])],
      controllers: [EmailIntakeController, EmailSettingsController, EmailSourceController],
      providers: [
        EmailIntakeService,
        EmailAllowlistService,
        EmailSourceReader,
        EmailSourceDeletion,
        EmailSourceService,
        MailIntakeGuard,
        { provide: MAIL_OPTIONS, useValue: options.mail },
      ],
      exports: [
        EmailIntakeService,
        EmailAllowlistService,
        EmailSourceReader,
        EmailSourceDeletion,
        EmailSourceService,
        MAIL_OPTIONS,
      ],
    };
  }
}
