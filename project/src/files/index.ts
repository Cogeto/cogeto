/**
 * files — document upload, stored or extract-and-discard (V2.0 item 3.6
 * part 4, split out of connectors).
 *
 * Public interface: the module, the service, ingestion's reader adapter, and
 * the pure document-extraction contract other capture families reuse (email
 * attachments, fetched PDF pages).
 */
export { FilesModule } from './files.module';
export { FilesService } from './files.service';
export { FileSourceReader } from './file.source-reader';
export { FILE_UPLOAD_OPTIONS } from './file-upload-options';
export type { FileUploadOptions } from './file-upload-options';
export {
  extractDocumentText,
  sniffContentType,
  PermanentExtractionError,
} from './document-extract';
