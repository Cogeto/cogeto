import { Injectable } from '@nestjs/common';
import type { MemoryScope } from '@cogeto/shared';
import type { Tx } from '../infrastructure/index';
import { MemoryFileStore, MemoryObjectStore } from '../memory/index';
import type { SourceItem, SourceReader } from '../ingestion/index';
import { extractDocumentText } from './document-extract';

/** Derives a source key's staging twin: the scope segment becomes `staging`. */
function toStagingKey(sourceKey: string): string {
  const parts = sourceKey.split('/');
  parts[parts.length - 2] = 'staging';
  return parts.join('/');
}

/**
 * Ingestion's stage-1 port for source_type 'file' (F1 handoff): the pipeline
 * reads a file source through this exactly like a note, and the SAME downstream
 * stages run — never a fork. Two storage modes:
 *
 * - **Stored**: a `file_metadata` row + a durable object at the source key.
 * - **Discard** (§A.9, handoff §3): no `file_metadata`, no durable object; the
 *   bytes are staged at the key's staging twin, carrying owner/scope/sensitive
 *   in the object's metadata (there is no row to read them from). The returned
 *   SourceItem sets `stagingKey`, and the pipeline deletes it once the derived
 *   memories commit.
 *
 * Never touches file_metadata or MinIO directly — both are the memory module's
 * (§A.1 rule 2), reached only through its public interfaces.
 */
@Injectable()
export class FileSourceReader implements SourceReader {
  readonly sourceType = 'file' as const;

  constructor(
    private readonly files: MemoryFileStore,
    private readonly objects: MemoryObjectStore,
  ) {}

  async load(sourceId: string): Promise<SourceItem | null> {
    const metadata = await this.files.get(sourceId);
    if (metadata) return this.loadStored(sourceId, metadata);
    return this.loadDiscard(sourceId);
  }

  /**
   * Admission checkpoint (decision 0024), stored mode only: KEY SHARE on the
   * file_metadata row through the memory module's port. The pipeline never
   * calls this for discard-mode sources (stagingKey set) — they have no
   * durable row by design and are covered by the saga's key cancellation.
   */
  async existsForAdmission(tx: Tx, sourceId: string): Promise<boolean> {
    return this.files.existsForAdmission(tx, sourceId);
  }

  private async loadStored(
    sourceId: string,
    metadata: NonNullable<Awaited<ReturnType<MemoryFileStore['get']>>>,
  ): Promise<SourceItem | null> {
    // The object was deleted (by the saga) before this job ran → vanished.
    const stat = await this.objects.statObject(sourceId);
    if (!stat) return null;
    const object = await this.objects.getObject(sourceId);
    const content = await extractDocumentText(object.body, object.contentType);
    return {
      sourceType: this.sourceType,
      sourceId,
      ownerId: metadata.ownerId,
      content,
      createdAt: metadata.uploadDate,
      scope: metadata.scope,
      sensitive: metadata.sensitive,
    };
  }

  private async loadDiscard(sourceId: string): Promise<SourceItem | null> {
    const stagingKey = toStagingKey(sourceId);
    // No file_metadata AND no staging object → the source never existed here or
    // its bytes were already cleaned; nothing to do (complete cleanly). A
    // present staging object means a discard-mode upload awaiting extraction.
    const stat = await this.objects.statObject(stagingKey);
    if (!stat) return null;

    const object = await this.objects.getObject(stagingKey);
    const md = object.metadata;
    const content = await extractDocumentText(object.body, object.contentType);
    return {
      sourceType: this.sourceType,
      sourceId,
      ownerId: md['owner-id'] ?? '',
      content,
      createdAt: md['uploaded-at'] ? new Date(md['uploaded-at']!) : new Date(),
      scope: (md['scope'] as MemoryScope | undefined) ?? 'private',
      sensitive: md['sensitive'] === 'true',
      // Signals the pipeline to delete the staging object once memories commit.
      stagingKey,
    };
  }
}
