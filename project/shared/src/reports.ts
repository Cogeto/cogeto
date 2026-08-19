/**
 * The findings report (V2.3 item 6.2): API DTOs for the run ledger the SPA
 * polls and the download endpoint. The report PAYLOAD (the signed artifact) is
 * not modelled here: its contract is the published JSON Schema in
 * docs/findings-report-schema/, mirrored in code by the reports module's
 * format file, exactly as the passport does it.
 */

/**
 * Version stamped into every generated report and its published schema.
 *
 * 1.2 (V3 spaces session 4) is ADDITIVE over 1.1: the scope block gained
 * `space_id` and `space_name`, because a report forwarded to an auditor must
 * say which sealed partition it describes (docs/features/spaces.md section
 * 6c). 1.1 (V2.5 item 8.3) was ADDITIVE over 1.0: the scope block gained
 * `project_id` and `project_name`, and its `kind` gained `project`, so a
 * client-facing report names the client it is about. Nothing about the
 * integrity block, the canonicalization or the signing procedure has ever
 * moved, and every older artifact keeps verifying against its own schema,
 * which stays published forever (the passport rule).
 */
export const FINDINGS_REPORT_VERSION = '1.2';

export const FINDINGS_REPORT_STATUSES = [
  'pending',
  'running',
  'ready',
  'failed',
  'expired',
] as const;
export type FindingsReportStatus = (typeof FINDINGS_REPORT_STATUSES)[number];

/**
 * What a run examined. The scope is part of the report and stated on it: a
 * finding count means nothing without knowing what was looked at.
 */
export type ReportScopeDto =
  | { kind: 'corpus' }
  | { kind: 'import'; importRunId: string }
  | { kind: 'sources'; refs: { sourceType: string; sourceId: string }[] }
  | { kind: 'date_range'; from: string; to: string }
  /**
   * A project (V2.5 item 8.3): the run enumerates exactly that project's
   * source assignments. This is how a client-facing report contains that
   * client's documents STRUCTURALLY, rather than because the user
   * remembered to tick the right boxes.
   */
  | { kind: 'project'; projectId: string };

export const REPORT_SCOPE_KINDS = ['corpus', 'import', 'sources', 'date_range', 'project'] as const;
export type ReportScopeKind = (typeof REPORT_SCOPE_KINDS)[number];

/** Stamped once at ready; every number computed from the owning stores. */
export interface FindingsReportCountsDto {
  sourcesExamined: number;
  sourcesUnreadable: number;
  sourcesTruncated: number;
  gateRefusals: number;
  facts: number;
  findingsOpen: number;
  findingsResolved: number;
  supersededFacts: number;
  suppressedFacts: number;
  /** Null when no previous run over the same scope existed. */
  resolvedSincePrevious: number | null;
  newSincePrevious: number | null;
  reopenedSincePrevious: number | null;
}

export type ReportProgressStage =
  'enumerating' | 'assembling' | 'rendering' | 'signing' | 'uploading';

export interface ReportProgressDto {
  stage: ReportProgressStage;
  /** Sources processed so far / total in scope, for the assembling stage. */
  done: number;
  total: number;
}

export interface FindingsReportDto {
  id: string;
  status: FindingsReportStatus;
  reportVersion: string;
  locale: string;
  scope: ReportScopeDto;
  modelConfigId: string | null;
  previousReportId: string | null;
  counts: FindingsReportCountsDto | null;
  progress: ReportProgressDto | null;
  payloadSha256: string | null;
  pdfFilename: string;
  jsonFilename: string;
  pdfSizeBytes: number | null;
  jsonSizeBytes: number | null;
  createdAt: string;
  readyAt: string | null;
  expiresAt: string | null;
  error: string | null;
}

export const REPORT_DOWNLOAD_FORMATS = ['pdf', 'json'] as const;
export type ReportDownloadFormat = (typeof REPORT_DOWNLOAD_FORMATS)[number];

export interface ReportDownloadDto {
  url: string;
  expiresInSeconds: number;
}
