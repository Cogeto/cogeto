/**
 * reports — the findings report (V2.3 item 6.2): the signed, printable
 * artifact from a findings run, in PDF and JSON from one payload.
 */
export { ReportsModule, FindingsReportCascadeModule } from './reports.module';
export { FindingsReportCascade } from './report.source-expiry';
export { ReportService } from './report.service';
export { ReportExportExecutor } from './report-export.executor';
export {
  REPORT_GENERATE_JOB_TYPE,
  REPORT_RETENTION_JOB_TYPE,
  REPORT_RETENTION_CRONTAB,
} from './report-jobs';
export { REPORT_OPTIONS, REPORT_RETENTION_HOURS } from './report.options';
export type { ReportOptions, ReportModelConfig } from './report.options';
export {
  reportPayloadSchema,
  reportArtifactSchema,
  reportArtifactBytes,
  assertReportPayloadSafe,
  sanitizeReportText,
  sha256Hex,
} from './report-format';
export type { ReportArtifact, ReportPayload } from './report-format';
export { buildReportFixturePayload } from './report-fixture';
