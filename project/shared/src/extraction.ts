/**
 * The per-source extraction gate (V2.1 item 4.3, spec 1.6): admission control
 * over extraction, per owner and source type. DTOs for the settings surface;
 * the enforcement lives in the ingestion pipeline.
 */

/** Rule dimensions code binds today; channel and folder arrive with connectors
 * and bulk import and are refused by the API until something enforces them. */
export const EXTRACTION_GATE_DIMENSIONS = ['document_class', 'source_id'] as const;
export type ExtractionGateDimension = (typeof EXTRACTION_GATE_DIMENSIONS)[number];

export type ExtractionGateEffect = 'allow' | 'deny';

/** Why the gate refused a source; each row in the ledger names one. */
export const EXTRACTION_REFUSAL_REASONS = [
  'extraction_disabled',
  'source_disabled',
  'document_class_denied',
] as const;
export type ExtractionRefusalReasonDto = (typeof EXTRACTION_REFUSAL_REASONS)[number];

/** The document classes the reading layer detects (its format ids). */
export const EXTRACTION_DOCUMENT_CLASSES = ['pdf', 'docx', 'xlsx', 'csv', 'image'] as const;

export interface ExtractionGateDto {
  sourceType: string;
  enabled: boolean;
  /** NULL: the source-type registry's budget (and the parse cap) decide. */
  factBudget: number | null;
  /** NULL: facts keep their own validity; nothing expires them by age. */
  retentionDays: number | null;
  updatedAt: string;
}

export interface ExtractionGateRuleDto {
  id: string;
  sourceType: string;
  dimension: ExtractionGateDimension;
  value: string;
  effect: ExtractionGateEffect;
  createdAt: string;
}

export interface ExtractionRefusalDto {
  id: string;
  sourceType: string;
  sourceId: string;
  reason: ExtractionRefusalReasonDto;
  documentClass: string | null;
  refusedAt: string;
}

export interface ExtractionGateConfigDto {
  /** Source types the gate can control: registered, extraction-capable. */
  sourceTypes: string[];
  gates: ExtractionGateDto[];
  rules: ExtractionGateRuleDto[];
  recentRefusals: ExtractionRefusalDto[];
}

export interface SetExtractionGateRequest {
  enabled?: boolean;
  /** Explicit null clears the budget back to the registry default. */
  factBudget?: number | null;
  /** Explicit null clears the retention back to keep-forever. */
  retentionDays?: number | null;
}

export interface AddExtractionGateRuleRequest {
  sourceType: string;
  dimension: ExtractionGateDimension;
  value: string;
  effect: ExtractionGateEffect;
}

/**
 * The source context (V2.1 item 4.2, spec 1.5): what a document as a whole is
 * about, produced by the anchoring call and editable by the owner. Editing it
 * and reprocessing the source re-anchors its facts as supersessions.
 */
export interface SourceContextSubjectDto {
  name: string;
  confident: boolean;
}

export interface SourceContextDto {
  sourceType: string;
  sourceId: string;
  subjects: SourceContextSubjectDto[];
  documentClass: string | null;
  documentClassConfident: boolean;
  revision: string | null;
  revisionConfident: boolean;
  /** True once the owner corrected it; the anchor call then never overwrites. */
  editedByUser: boolean;
  /** The anchoring prompt that produced a machine context; null once edited. */
  promptVersion: string | null;
  updatedAt: string;
}

export interface SetSourceContextRequest {
  /** `confident` defaults to true: a subject the user typed is not a guess. */
  subjects: { name: string; confident?: boolean }[];
  documentClass: string | null;
  revision: string | null;
}
