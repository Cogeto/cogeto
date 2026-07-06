import { Injectable } from '@nestjs/common';
import { MemoryFileStore, MemoryObjectStore } from '../memory/index';
import type { SourceItem, SourceReader } from '../ingestion/index';
import { extractDocumentText } from './document-extract';

/**
 * Ingestion's stage-1 port for source_type 'file' (F1 handoff): the pipeline
 * reads a file source through this exactly like a note. It resolves the
 * upload's governance from the memory module's file-metadata port, pulls the
 * bytes from the memory module's object store, and extracts clean text — the
 * SAME downstream stages then run (extract → verify → embed+store → reconcile),
 * NOT a fork. Derived facts inherit the upload's scope + sensitive flags, so
 * the SourceItem carries them.
 *
 * Bound to SOURCE_READERS by the worker composition root, alongside
 * NotesSourceReader. Never touches file_metadata or MinIO directly — both are
 * the memory module's tables/clients (§A.1 rule 2), reached only through its
 * public interfaces.
 */
@Injectable()
export class FileSourceReader implements SourceReader {
  readonly sourceType = 'file' as const;

  constructor(
    private readonly files: MemoryFileStore,
    private readonly objects: MemoryObjectStore,
  ) {}

  async load(sourceId: string): Promise<SourceItem | null> {
    // Absence of the metadata row means the source vanished (deleted by the
    // saga before this job ran, or a discard-mode key with no durable original)
    // — the pipeline completes cleanly with nothing to do.
    const metadata = await this.files.get(sourceId);
    if (!metadata) return null;

    const object = await this.objects.getObject(sourceId);
    // A parse failure throws PermanentExtractionError → the pipeline job
    // dead-letters and the file's status reads `error`; zero memories, never a
    // fabricated one.
    const content = await extractDocumentText(object.body, object.contentType);

    return {
      sourceType: this.sourceType,
      sourceId,
      ownerId: metadata.ownerId,
      content,
      // Temporal expressions resolve against when the document was uploaded.
      createdAt: metadata.uploadDate,
      scope: metadata.scope,
      sensitive: metadata.sensitive,
    };
  }
}
