/**
 * files — document upload, stored or extract-and-discard (V2.0 item 3.6
 * part 4, split out of connectors), and the READING LAYER behind it
 * (V2.1 item 4.1).
 *
 * Public interface: the module, the service, ingestion's reader adapter, the
 * deletion cascade for the read report, and the pure document-reading contract
 * other capture families reuse (email attachments, fetched PDF pages).
 */
export { FilesModule, FileReadReportCascadeModule } from './files.module';
export { FilesService } from './files.service';
export type { UploadedFile, UploadFlags } from './files.service';
export { FileSourceReader } from './file.source-reader';
export { FileReadReportCascade } from './file-read-report.cascade';
export { FILE_UPLOAD_OPTIONS } from './file-upload-options';
export { extractDocumentText, sniffContentType } from './document-extract';
// The shared laddered read (V2.2 item 5.1): bytes → text + report through the
// full ladder (text layer, OCR, probed vision) under the parse caps — the ONE
// reading path a transient chat attachment shares with a durable upload. The
// multipart interceptor rides along so the chat attachment endpoint enforces
// the same byte cap the upload endpoint does.
export { LadderedDocumentReader } from './laddered-read';
export { DocumentUploadInterceptor } from './document-upload.interceptor';
// The reader seam. A format Cogeto can read is a registered reader, never a
// branch in a switch: `readDocument` selects by magic bytes (the declared type
// and the extension are hints), runs the reader under the parse caps, and
// returns text plus the structured locators V2.2 and V2.3 render.
export { readDocument, DOCUMENT_READERS, selectReader } from './reading/registry';
export { locateSpan, describeLocator } from './reading/locator';
export type { ReadLocator, ReadSegment, ReadGranularity } from './reading/locator';
export { PermanentExtractionError } from './reading/reader';
export type {
  DocumentReader,
  DocumentFormat,
  ReadResult,
  ReadReport,
  ReadOutcome,
  ReadReasonCode,
} from './reading/reader';

// The source catalog's read-report badges (V2.2 item 5.2).
export { readOutcomesForKeys, keysWithReadOutcome } from './persistence/file-read-report';
// The full per-source read report (V2.3 item 6.2): the findings report's
// coverage section explains truncation and per-page tiers from it.
export { FileReadReportStore } from './persistence/file-read-report';
