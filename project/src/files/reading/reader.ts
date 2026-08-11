import { Readable } from 'node:stream';
import type { ParseCaps } from '../../infrastructure/index';
import type { PageLadderServices } from './page-ladder';
import type { ReadGranularity, ReadSegment } from './locator';

/**
 * The reader contract (V2.1 item 4.1, issue A1).
 *
 * A format Cogeto can read is a REGISTERED READER, never a branch in a switch.
 * Each reader declares what it handles, what it needs, and how precisely it can
 * say where a piece of text came from; the registry does selection, capping and
 * failure classification once, for all of them. Adding OCR and the vision tier
 * (the other half of 4.1) is adding readers here, not editing a dispatcher.
 */

/** The formats registered today. A new reader adds a member. */
export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'text' | 'image';

/**
 * What the registry hands a reader. `bytes` is always populated (the worker
 * already holds the object in memory); `stream()` exists so a reader that
 * declares `input: 'stream'` gets what it declared rather than a buffer it did
 * not ask for. Both views are over the same bytes.
 */
export interface ReadInput {
  bytes: Buffer;
  /**
   * The reading ladder's executable tiers (V2.1 item 4.1), when the caller has
   * them. ABSENT is a complete and supported state: without it a PDF is read
   * from its text layer exactly as it was before the ladder existed, which is
   * what keeps every existing document's text byte-identical and what lets the
   * eval harness read fixtures without a rasterizer.
   */
  ladder?: PageLadderServices;
  /** A fresh readable over `bytes`. Safe to call more than once. */
  stream(): Readable;
  /** The uploader's filename, when known. A HINT for selection, never trusted. */
  filename: string | null;
  /** The content type the caller declared, normalized. A hint, never trusted. */
  declaredContentType: string | null;
  caps: ParseCaps;
}

export interface DocumentReader {
  readonly format: DocumentFormat;
  /** Content types this reader claims, lower-case, without parameters. */
  readonly contentTypes: readonly string[];
  /** Extensions this reader claims, lower-case, with the dot. Hints only. */
  readonly extensions: readonly string[];
  /**
   * True when `sniffFormat` can identify this format from its bytes. It decides
   * what happens to a MISLABELLED file: for a detectable format, bytes that are
   * not that format mean the label is wrong and the upload is refused; a text
   * format has no signature to check, so its label and extension are all there
   * is to go on.
   */
  readonly detectable: boolean;
  /** Whether the reader works from the raw bytes or from a stream. */
  readonly input: 'bytes' | 'stream';
  /** The finest provenance this reader can produce for a span. */
  readonly granularity: ReadGranularity;
  read(input: ReadInput): Promise<ReadResult>;
}

/**
 * How a read ended. `truncated` still produced text and is a SUCCESS: the file
 * was read, partially, and the source says so. The two failures are kept apart
 * on purpose (issue A4): "Cogeto cannot read this kind of file" and "Cogeto
 * should have been able to read this file and could not" are different facts
 * about the world and lead a user to different actions.
 */
export type ReadOutcome =
  | 'read'
  | 'truncated'
  | 'empty'
  | 'unsupported_format'
  | 'read_failed'
  /**
   * Pages that need a model that can see, on an instance that cannot (V2.1
   * item 4.1). Distinct from `empty` because it is not a fact about the
   * document, it is a fact about this instance's configuration, and it becomes
   * readable the moment vision is enabled. The reprocess action exists for
   * exactly these.
   */
  | 'needs_vision';

/**
 * The specific reason behind the outcome. An enum value, never a sentence: the
 * SPA maps it to a translated string through an explicit value → key map
 * (AGENTS.md, user-visible copy), so a reason is readable in every locale and
 * a reader never emits English prose into the interface.
 */
export type ReadReasonCode =
  // truncated
  | 'row_cap_sheet'
  | 'row_cap_file'
  // empty
  | 'no_text'
  // unsupported_format
  | 'unsupported_type'
  | 'legacy_office_format'
  // needs_vision / partially read
  | 'vision_unavailable'
  | 'vision_cap_reached'
  | 'vision_failed'
  | 'no_readable_text'
  // read_failed
  | 'parse_failed'
  | 'parse_timeout'
  // Over the char cap: `truncated` when the text reader cut at a paragraph
  // boundary and said so; `read_failed` when the registry's bomb guard refused.
  | 'text_over_cap'
  | 'undecodable_text';

/** Per-sheet accounting for a tabular read; what makes truncation honest. */
export interface SheetReadDetail {
  name: string | null;
  index: number;
  /** Data rows turned into statements. */
  rowsRead: number;
  /** Data rows the sheet actually holds, as far as the reader could see. */
  rowsTotal: number;
  truncated: boolean;
}

/**
 * The structured record of what happened, stored on the source and rendered in
 * the source drawer. Identifiers, counts and enum values only. Sheet names are
 * document content, which is why the row lives in the deletion cascade.
 */
/**
 * What happened to one page of a paginated document (V2.1 item 4.1). This is
 * what makes "the file was read" answerable page by page instead of as a single
 * yes: a 40-page scan where 38 pages read and 2 needed vision is neither a
 * success nor a failure, and the drawer has to be able to say so.
 */
export interface PageReadDetail {
  page: number;
  /** The tier that produced this page's text, or null when it was not read. */
  tier: 'text' | 'ocr' | 'vision' | null;
  /** Why it was not read. Null when it was. */
  reason: string | null;
}

export interface ReadReport {
  format: DocumentFormat | null;
  granularity: ReadGranularity;
  outcome: ReadOutcome;
  reasonCode: ReadReasonCode | null;
  /** Statements or text segments produced. */
  segments: number;
  sheets: SheetReadDetail[];
  /**
   * Cells whose stored value could not be recovered (a formula with no cached
   * result, an error value). Capped for storage; `valuesUnavailable` is the
   * true total, `unavailableCells` the first few, as A1 references.
   */
  valuesUnavailable: number;
  unavailableCells: string[];
  /** CSV only: what delimiter detection settled on. */
  delimiter?: string;
  /** Signature-less text formats (CSV, text): the encoding actually used, so
   * the fallback is inspectable. */
  encoding?: string;
  /** Per-page outcomes for a paginated document read through the ladder. */
  pages?: PageReadDetail[];
  /** How many pages were escalated to the vision tier, for cost visibility. */
  visionPagesUsed?: number;
}

export interface ReadResult {
  text: string;
  segments: ReadSegment[];
  report: ReadReport;
}

/**
 * A parse failure: permanent, do-not-fabricate (spec §2, scope §4.9). Carries
 * the classification the source row records, so the drawer can say which of the
 * two things went wrong instead of "extraction failed".
 *
 * Named `PermanentExtractionError` still, because it IS the same error the
 * pipeline has always let propagate so the job dead-letters and the file's
 * status reads `error`; only the classification is new.
 */
export class PermanentExtractionError extends Error {
  readonly outcome: Extract<ReadOutcome, 'unsupported_format' | 'read_failed'>;
  readonly reasonCode: ReadReasonCode;
  readonly format: DocumentFormat | null;

  constructor(
    message: string,
    options: {
      outcome: Extract<ReadOutcome, 'unsupported_format' | 'read_failed'>;
      reasonCode: ReadReasonCode;
      format?: DocumentFormat | null;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PermanentExtractionError';
    this.outcome = options.outcome;
    this.reasonCode = options.reasonCode;
    this.format = options.format ?? null;
  }
}

/** "Cogeto does not read this kind of file." */
export function unsupportedFormat(
  message: string,
  reasonCode: Extract<
    ReadReasonCode,
    'unsupported_type' | 'legacy_office_format'
  > = 'unsupported_type',
): PermanentExtractionError {
  return new PermanentExtractionError(message, { outcome: 'unsupported_format', reasonCode });
}

/** "Cogeto reads this kind of file and could not read this one." */
export function readFailed(
  message: string,
  options: {
    reasonCode: Extract<
      ReadReasonCode,
      'parse_failed' | 'parse_timeout' | 'text_over_cap' | 'undecodable_text'
    >;
    format?: DocumentFormat | null;
    cause?: unknown;
  },
): PermanentExtractionError {
  return new PermanentExtractionError(message, { outcome: 'read_failed', ...options });
}

/** The empty report a caller records when nothing could even be classified. */
export function emptyReport(format: DocumentFormat | null, outcome: ReadOutcome): ReadReport {
  return {
    format,
    granularity: 'document',
    outcome,
    reasonCode: null,
    segments: 0,
    sheets: [],
    valuesUnavailable: 0,
    unavailableCells: [],
  };
}
