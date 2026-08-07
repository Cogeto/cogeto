import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { UserContextModule } from '../infrastructure/index';
import { SuppressedFactLog, SourceContextStore, SourceRevisionStore } from '../ingestion/index';
import { FileReadReportStore } from '../files/index';
import { ReportsController } from './reports.controller';
import { ReportService } from './report.service';
import { ReportStore } from './report.store';
import { ReportAssembler } from './report-assembler';
import { ReportExportExecutor } from './report-export.executor';
import { FindingsReportCascade } from './report.source-expiry';
import { REPORT_OPTIONS } from './report.options';
import type { ReportOptions } from './report.options';

/**
 * reports — the findings report (V2.3 item 6.2): a signed, printable artifact
 * from a findings run. Owns only the run ledger; every fact, finding, span,
 * revision and refusal it states is re-read at generation time through the
 * owning modules' public, Principal-gated interfaces (the sources/ shape,
 * worker-side). The worker signs with the instance key; the app only
 * triggers, polls and downloads.
 *
 * `SuppressedFactLog`, `SourceContextStore`, `SourceRevisionStore` and
 * `FileReadReportStore` are the owners' exported classes provided directly:
 * each carries only its own table access over the global DRIZZLE (the
 * ChatSourceModule precedent for slim reuse).
 */
@Module({})
export class ReportsModule {
  /** App slice: trigger, poll, download. No signer, no assembler. */
  static register(
    options: Pick<ReportOptions, 'downloadUrlTtlSeconds'> & {
      imports?: ModuleMetadata['imports'];
    },
  ): DynamicModule {
    return {
      module: ReportsModule,
      // UserContextModule: the trigger resolves the owner's preferred
      // language (the report's anchor locale) through it.
      imports: [UserContextModule, ...(options.imports ?? [])],
      controllers: [ReportsController],
      providers: [{ provide: REPORT_OPTIONS, useValue: options }, ReportService, ReportStore],
      exports: [ReportService],
    };
  }

  /** Worker slice: generation, signing, retention. */
  static forWorker(
    options: ReportOptions & { imports?: ModuleMetadata['imports'] },
  ): DynamicModule {
    return {
      module: ReportsModule,
      imports: [...(options.imports ?? [])],
      providers: [
        { provide: REPORT_OPTIONS, useValue: options },
        ReportStore,
        ReportAssembler,
        ReportExportExecutor,
        SuppressedFactLog,
        SourceContextStore,
        SourceRevisionStore,
        FileReadReportStore,
      ],
      exports: [ReportExportExecutor, ReportStore],
    };
  }
}

/**
 * The reports arm of the deletion saga. Deliberately dependency-free (the
 * passport cascade precedent): the cascade works entirely inside the
 * transaction the saga hands it, so registering it cannot pull the reports
 * module's own wiring into the memory module's graph.
 */
@Module({
  providers: [FindingsReportCascade],
  exports: [FindingsReportCascade],
})
export class FindingsReportCascadeModule {}
