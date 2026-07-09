/** Public interface of the connectors bounded context (§A.1 rule 1). */
export { ConnectorsModule } from './connectors.module';
export type { ConnectorsModuleOptions } from './connectors.module';
export { NotesService } from './notes.service';
export { NotesSourceReader } from './notes.source-reader';
export { NotesSourceDeletion } from './notes.source-deletion';
export { FilesService } from './files.service';
export { FileSourceReader } from './file.source-reader';
export { UserSettingsService } from './user-settings.service';
export { FILE_UPLOAD_OPTIONS } from './file-upload-options';
export type { FileUploadOptions } from './file-upload-options';
export {
  extractDocumentText,
  sniffContentType,
  PermanentExtractionError,
} from './document-extract';
