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
export { FileSourceReader } from './file.source-reader';
export { FileReadReportCascade } from './file-read-report.cascade';
export { FILE_UPLOAD_OPTIONS } from './file-upload-options';
export { extractDocumentText, sniffContentType } from './document-extract';
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
