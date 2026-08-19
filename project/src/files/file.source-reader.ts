import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { MemoryScope } from '@cogeto/shared';
import { DailyCounters, DEFAULT_PARSE_CAPS, PARSE_CAPS } from '../infrastructure/index';
import type { ParseCaps, Tx } from '../infrastructure/index';
import { MemoryFileStore, MemoryObjectStore } from '../memory/index';
import type { SourceItem, SourceReader } from '../ingestion/index';
import { FileReadReportStore } from './persistence/file-read-report';
import { LadderedDocumentReader, VisionSource } from './laddered-read';
import { emptyReport, PermanentExtractionError } from './reading/reader';
import type { ReadResult } from './reading/reader';

// VisionSource moved to ./laddered-read with the shared laddered reader (V2.2
// item 5.1); re-exported here so existing import sites keep working.
export { VisionSource, VISION_PAGE_BUCKET } from './laddered-read';

/**
 * The stored filename, URL-decoded (S3 metadata must be US-ASCII). A HINT for
 * reader selection: a text format has no magic bytes, so its extension is the
 * only signal, and the bytes still outrank it for every format that has one.
 */
function decodeFilename(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Derives a source key's staging twin: the scope segment becomes `staging`. */
function toStagingKey(sourceKey: string): string {
  const parts = sourceKey.split('/');
  parts[parts.length - 2] = 'staging';
  return parts.join('/');
}

/**
 * Ingestion's stage-1 port for source_type 'file' (F1 handoff): the pipeline
 * reads a file source through this exactly like a note, and the SAME downstream
 * stages run — never a fork. Two storage modes
 *
 * - **Stored**: a `file_metadata` row + a durable object at the source key.
 * - **Discard** (handoff §3): no `file_metadata`, no durable object; the
 *   bytes are staged at the key's staging twin, carrying owner/scope/sensitive
 *   in the object's metadata (there is no row to read them from). The returned
 *   SourceItem sets `stagingKey`, and the pipeline deletes it once the derived
 *   memories commit.
 *
 * Never touches file_metadata or MinIO directly — both are the memory module's
 * (spec §15 rule 2), reached only through its public interfaces.
 */
@Injectable()
export class FileSourceReader implements SourceReader {
  readonly sourceType = 'file' as const;
  private readonly logger = new Logger(FileSourceReader.name);

  constructor(
    private readonly files: MemoryFileStore,
    private readonly objects: MemoryObjectStore,
    /** Parse caps; optional so a bare/test construction still works. */
    @Optional() @Inject(PARSE_CAPS) private readonly parseCaps: ParseCaps = DEFAULT_PARSE_CAPS,
    /**
     * The read report (V2.1 item 4.1). Optional and appended LAST so a bare
     * construction (tests, the eval harness) still works; when it is absent the
     * read behaves exactly as before, it is simply not explained afterwards.
     */
    @Optional() private readonly reports?: FileReadReportStore,
    /**
     * The reading ladder's vision tier (V2.1 item 4.1). Optional and supplied
     * ONLY by a root that has both a configured vision binding and a working
     * probe: a tier that is configured but broken is not vision, and handing it
     * over would turn every picture page into a slow failure instead of an
     * honest label.
     */
    @Optional() private readonly visionGateway?: VisionSource,
    /** Per-user daily vision spend, for the second of the two caps. */
    @Optional() private readonly counters?: DailyCounters,
  ) {}

  /**
   * Reads the bytes and records what happened, in both directions.
   *
   * The failure path is the reason this wrapper exists. A permanent read
   * failure propagates (the pipeline job retries, then dead-letters, and the
   * file's state reads `error`, all unchanged), but before it propagates the
   * reason is committed on its own connection, so the source drawer can say
   * whether Cogeto does not read this KIND of file or failed to read THIS one.
   */
  private async readAndRecord(
    sourceId: string,
    ownerId: string,
    bytes: Buffer,
    contentType: string | null,
    filename: string | null,
  ): Promise<ReadResult> {
    // ONE laddered read for every caller (V2.2 item 5.1): the shared reader
    // is constructed from this adapter's own deps so the DI signature (and
    // every bare construction site) stays exactly as it was.
    const laddered = new LadderedDocumentReader(this.parseCaps, this.visionGateway, this.counters);
    try {
      const result = await laddered.read(ownerId, bytes, contentType, filename);
      await this.reports?.record(sourceId, ownerId, result.report, this.logger);
      return result;
    } catch (error) {
      if (error instanceof PermanentExtractionError) {
        await this.reports?.record(
          sourceId,
          ownerId,
          {
            ...emptyReport(error.format, error.outcome),
            reasonCode: error.reasonCode,
          },
          this.logger,
        );
      }
      throw error;
    }
  }

  async load(sourceId: string): Promise<SourceItem | null> {
    const metadata = await this.files.get(sourceId);
    if (metadata) return this.loadStored(sourceId, metadata);
    return this.loadDiscard(sourceId);
  }

  /**
   * Admission checkpoint, stored mode only: KEY SHARE on the
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
    const storedFilename = decodeFilename(object.metadata['original-filename']);
    const { text, segments, report } = await this.readAndRecord(
      sourceId,
      metadata.ownerId,
      object.body,
      object.contentType,
      storedFilename,
    );
    return {
      sourceType: this.sourceType,
      sourceId,
      ownerId: metadata.ownerId,
      content: text,
      // The reader's provenance segments ride to admission, where each stored
      // fact's span is located once (V2.2 item 5.2).
      segments,
      createdAt: metadata.uploadDate,
      scope: metadata.scope,
      sensitive: metadata.sensitive,
      // The source row's space (docs/features/spaces.md): every derived fact
      // inherits it at admission, exactly like scope and sensitive.
      spaceId: metadata.spaceId,
      // A document is someone else's writing, even when the user uploaded it.
      // Its obligations are facts about the document, never the user's own
      // commitments, so they never become open loops.
      authoredByUser: false,
      // The sniffed format, for the extraction gate's document-class rules
      // (V2.1 item 4.3) — what the bytes ARE, never what the label claimed.
      documentClass: report.format ?? undefined,
      // For the anchor call (V2.1 item 4.2): the filename often carries the
      // subject or revision the first page repeats.
      filename: storedFilename ?? undefined,
      // A connector's sub-scope key, for the gate's folder rules (V2.5 item
      // 8.2); plain uploads carry none.
      gateFolder: decodeFilename(object.metadata['gate-folder']) ?? undefined,
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
    // Recorded under the SOURCE key, never the staging key: a staging key never
    // enters file_metadata, provenance or any receipt (F1 handoff §3), and the
    // report has to survive the staging object it describes.
    const discardFilename = decodeFilename(md['original-filename']);
    const { text, segments, report } = await this.readAndRecord(
      sourceId,
      md['owner-id'] ?? '',
      object.body,
      object.contentType,
      discardFilename,
    );
    return {
      sourceType: this.sourceType,
      sourceId,
      ownerId: md['owner-id'] ?? '',
      content: text,
      // Discard mode is exactly why locators persist at admission (V2.2 item
      // 5.2): once the staging bytes go, this read was the only chance.
      segments,
      createdAt: md['uploaded-at'] ? new Date(md['uploaded-at']!) : new Date(),
      scope: (md['scope'] as MemoryScope | undefined) ?? 'private',
      sensitive: md['sensitive'] === 'true',
      // Discard mode has no row, so the space rides the staging object's
      // metadata beside owner/scope/sensitive (docs/features/spaces.md).
      spaceId: md['space-id'] ?? undefined,
      // Same rule as the durable path: a document is not the user's own voice.
      authoredByUser: false,
      // Same rule as the durable path: the sniffed format for the gate's
      // document-class rules (V2.1 item 4.3).
      documentClass: report.format ?? undefined,
      // Same rule as the durable path (V2.1 item 4.2).
      filename: discardFilename ?? undefined,
      // Signals the pipeline to delete the staging object once memories commit.
      stagingKey,
    };
  }
}
