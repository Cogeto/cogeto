import { createHash, randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  AwaitingCapabilityDto,
  FileProcessingState,
  FileReadReportDto,
  FileSourceDto,
  MemoryScope,
  Principal,
} from '@cogeto/shared';
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  CSV_ALIAS_CONTENT_TYPES,
  CSV_CONTENT_TYPE,
  MARKDOWN_CONTENT_TYPE,
  PLAIN_TEXT_CONTENT_TYPE,
} from '@cogeto/shared';
import {
  clearIdempotencyForReprocess,
  DailyCounters,
  DRIZZLE,
  enqueueDelayedJob,
  INGEST_QUOTA,
  jobRunState,
  untranslatedError,
  userError,
  withTransactionalEnqueue,
  writeAudit,
} from '../infrastructure/index';
import type { Db, IngestQuota } from '../infrastructure/index';
import { FILE_DISCARD_CLEANUP_JOB_TYPE, INGESTION_PIPELINE_JOB_TYPE } from '../ingestion/index';
import { MemoryFileStore, MemoryObjectStore, MemoryStore } from '../memory/index';
import { ProjectStore } from '../projects/index';
import { sniffContentType } from './document-extract';
import { FileReadReportStore } from './persistence/file-read-report';
import { FILE_UPLOAD_OPTIONS } from './file-upload-options';
import type { FileUploadOptions } from './file-upload-options';

/**
 * A permanent parse error still consumes retries, so file pipeline jobs cap
 * attempts low: a transient object-store blip gets a couple of retries, a
 * corrupt document reaches its `error` state promptly (notes keep the default
 * 10 — a note never "fails to parse").
 */
const FILE_PIPELINE_MAX_ATTEMPTS = 3;

/** Abort-window cleanup retries: quick in-line attempts before handing the
 * orphan to the nightly sweep's orphan-object arm. */
const CLEANUP_ATTEMPTS = 3;
const CLEANUP_RETRY_DELAY_MS = 250;

export interface UploadedFile {
  buffer: Buffer;
  originalName: string;
  /** The client-declared MIME type; cross-checked against the magic bytes. */
  mimeType: string;
}

export interface UploadFlags {
  scope: MemoryScope;
  sensitive: boolean;
  /** Extract-and-discard: keep no original after extraction. */
  discard: boolean;
}

export interface UploadOptions {
  jobPriority?: number;
  /** The extraction gate's folder-dimension value for this source (a
   * connector sub-scope key). Rides the object metadata to the pipeline;
   * absent for plain uploads. */
  gateFolder?: string;
  /**
   * The project this source belongs to (V2.5 item 8.3). Recorded in the SAME
   * transaction as the file metadata and the pipeline enqueue, so a source
   * never exists without the project it was uploaded into. Optional
   * everywhere: absent is the pre-feature path exactly, and a project is
   * organisation, never authorisation.
   */
  projectId?: string;
  /**
   * Resolve an upload of bytes this owner already stores to the EXISTING
   * source instead of creating a second one (issue #536).
   *
   * Opt-in, and default-off, because it is a policy of the INTERACTIVE
   * surfaces rather than a property of the mechanism. A person picking the
   * same file twice means "make sure this is in there"; a connector or an
   * importer materializing content means "this identified item's bytes",
   * and for them identical content is not identity. Two Confluence pages can
   * legitimately hold the same text, and collapsing them would repoint one
   * page's ledger entry and revision link at the other page's source. So the
   * controller and the chat paperclip pass true, and the connector and import
   * call sites keep the pre-existing behaviour byte for byte.
   */
  deduplicate?: boolean;
}

/**
 * The outcome of an upload. `duplicate` says the bytes were already stored
 * and `objectKey` is the EXISTING source: nothing was written, nothing was
 * enqueued, and no extraction was paid for a second time.
 */
export interface UploadResult {
  objectKey: string;
  duplicate?: boolean;
}

/** How long the staging object lingers before the backstop cleanup runs. */
const STAGING_BACKSTOP_MINUTES = 15;

/** Derives a source key's staging twin: the scope segment becomes `staging`. */
function toStagingKey(sourceKey: string): string {
  const parts = sourceKey.split('/');
  parts[parts.length - 2] = 'staging'; // {org}/{user}/{scope}/file-{uuid}
  return parts.join('/');
}

/**
 * The file source (F1 handoff) — the notes source's sibling in connectors, but
 * its bytes and metadata live in the memory module, so
 * this orchestrates the memory module's object store + file-metadata port and
 * the shared outbox; it owns no table of its own.
 *
 * Transactional ingestion (spec §15.4, handoff §1) — the safe order
 *   1. PUT the bytes to MinIO under the minted key (object-first).
 *   2. In ONE transaction: insert file_metadata (via the memory port) AND
 *      enqueue the pipeline job through the outbox (metadata-commit gating).
 *   3. If that transaction aborts, the object is an orphan → a compensating
 *      delete removes it (abort-window cleanup). A hard crash between (1) and
 *      (2) can leave a stray object, but with no file_metadata and no receipt
 *      referencing it the sweep is blind to it by construction — the same
 *      property discard-mode staging relies on (handoff §3).
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly objects: MemoryObjectStore,
    private readonly files: MemoryFileStore,
    private readonly memory: MemoryStore,
    @Inject(FILE_UPLOAD_OPTIONS) private readonly options: FileUploadOptions,
    private readonly counters: DailyCounters,
    @Inject(INGEST_QUOTA) private readonly quota: IngestQuota,
    /** What the reading layer made of each file (V2.1 item 4.1). */
    private readonly readReports: FileReadReportStore,
    /** Project assignment (V2.5 item 8.3), optional: a root that registers no
     * projects module uploads exactly as it did before. */
    @Optional() private readonly projects?: ProjectStore,
  ) {}

  /**
   * Compensating delete for the upload abort window
   * the metadata transaction failed, so the just-written object is a true
   * orphan. Retried in-line with a short backoff and LOGGED on every failure
   * (object keys are identifiers, never content — pino rule holds); if all
   * attempts fail, the nightly sweep's orphan-object arm detects and alerts.
   * Never throws — the caller rethrows the original upload error.
   */
  private async cleanupOrphanObject(objectKey: string): Promise<void> {
    for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await this.objects.deleteObject(objectKey);
        return;
      } catch {
        if (attempt === CLEANUP_ATTEMPTS) {
          this.logger.error(
            `abort-window cleanup failed after ${attempt} attempts; ` +
              `orphan object left for the integrity sweep: ${objectKey}`,
          );
          return;
        }
        this.logger.warn(`abort-window cleanup attempt ${attempt} failed for ${objectKey}`);
        await new Promise((resolve) => setTimeout(resolve, CLEANUP_RETRY_DELAY_MS * attempt));
      }
    }
  }

  async upload(
    principal: Principal,
    file: UploadedFile,
    flags: UploadFlags,
    /** Bulk import demotes its pipeline jobs so interactive work runs first
     * (V2.2 item 5.3); a plain upload keeps the default priority. A connector
     * stamps its sub-scope key as `gateFolder` so the extraction gate's
     * folder dimension can express per-container policy (V2.5 item 8.2). */
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    if (file.buffer.length === 0)
      throw userError.badRequest('file.empty', 'the uploaded file is empty');
    if (file.buffer.length > this.options.uploadMaxBytes) {
      throw userError.badRequest(
        'file.exceedsUploadLimit',
        'file exceeds the {{bytes}}-byte upload limit',
        { bytes: this.options.uploadMaxBytes },
      );
    }

    // Bytes this owner already stores resolve to the source that holds them
    // (issue #536), BEFORE the daily cap is charged and before anything is
    // written: a duplicate consumes no quota because it consumes no pipeline.
    // Discard mode is excluded by construction rather than by choice — it
    // writes no `file_metadata` row, so it has no checksum to match on, in
    // either direction. The request rate limit still applies, so this is not
    // a free unbounded endpoint.
    // Hashed once here rather than again inside `uploadStored`, because the
    // stored path needs the same digest for the metadata row.
    const checksum = flags.discard ? null : createHash('sha256').update(file.buffer).digest('hex');
    const existing =
      options.deduplicate && checksum ? await this.findDuplicate(principal, checksum, flags) : null;
    if (existing) {
      // A project is organisation, so filing the same document again under a
      // project is a meaningful thing to have asked for, and the only part of
      // the request a duplicate can still honour.
      if (options.projectId && this.projects) {
        await this.db.transaction(async (tx) => {
          await this.projects!.assignInTx(
            tx,
            principal.userId,
            { kind: 'source', refType: 'file', refId: existing },
            options.projectId!,
          );
        });
      }
      return { objectKey: existing, duplicate: true };
    }

    // Per-user daily upload cap: bounds the parse + pipeline work a
    // single user (or the shared demo principal) can drive in a day.
    if ((await this.counters.get(principal.userId, 'upload')) >= this.quota.uploadMax) {
      throw userError.tooManyRequests(
        'daily_upload_limit',
        'daily upload limit reached ({{max}}), try again tomorrow',
        { max: this.quota.uploadMax },
      );
    }
    const contentType = this.resolveContentType(file);
    await this.counters.add(principal.userId, 'upload', 1);

    // Object key contract (handoff §1): {orgId}/{userId}/{scope}/file-{uuid},
    // first segment the Zitadel org id — minted before anything is written, the
    // provenance anchor of every derived memory. Same in both modes.
    const objectKey = `${principal.orgId}/${principal.userId}/${flags.scope}/file-${randomUUID()}`;

    return flags.discard
      ? this.uploadDiscard(principal, file, flags, objectKey, contentType, options)
      : this.uploadStored(principal, file, flags, objectKey, contentType, checksum!, options);
  }

  /**
   * The stored source already holding these bytes for this owner, or null
   * (issue #536).
   *
   * A match on the hash alone is NOT enough. The existing source is only a
   * duplicate when it would have been admitted the way this request asks for:
   * a `private` original cannot answer an upload asking for `shared`, and a
   * non-sensitive original cannot answer one marked sensitive. Reusing it
   * anyway would silently ignore what the user asked; rewriting its scope
   * would move already-extracted facts across the gate, which an upload is
   * not the place to do. So a mismatch falls through and uploads normally,
   * and the two rows differ in exactly the way the user asked them to.
   */
  private async findDuplicate(
    principal: Principal,
    checksum: string,
    flags: UploadFlags,
  ): Promise<string | null> {
    const existing = await this.files.findDuplicate(principal.userId, checksum);
    if (!existing) return null;
    if (existing.scope !== flags.scope || existing.sensitive !== flags.sensitive) return null;
    return existing.objectKey;
  }

  /**
   * Stages the bytes of a TRANSIENT chat attachment (V2.2 item 5.1): the same
   * validation, caps, quota and content-type authority as `upload`, the same
   * staging-twin key discard mode uses — and deliberately nothing else. No
   * `file_metadata`, no pipeline job, no source: a transient file is
   * conversation-only, and the chat module owns the row, the read job and the
   * cleanup enqueue. Staging keys never enter provenance or receipts, so the
   * sweep is blind to them by construction, exactly as in discard mode.
   */
  async stageTransient(
    principal: Principal,
    file: UploadedFile,
  ): Promise<{ stagingKey: string; contentType: string; sizeBytes: number }> {
    if (file.buffer.length === 0)
      throw userError.badRequest('file.empty', 'the uploaded file is empty');
    if (file.buffer.length > this.options.uploadMaxBytes) {
      throw userError.badRequest(
        'file.exceedsUploadLimit',
        'file exceeds the {{bytes}}-byte upload limit',
        { bytes: this.options.uploadMaxBytes },
      );
    }
    // The same per-user daily cap as a durable upload: a transient file skips
    // extraction, but its read (OCR, vision) is the same bounded work.
    if ((await this.counters.get(principal.userId, 'upload')) >= this.quota.uploadMax) {
      throw userError.tooManyRequests(
        'daily_upload_limit',
        'daily upload limit reached ({{max}}), try again tomorrow',
        { max: this.quota.uploadMax },
      );
    }
    const contentType = this.resolveContentType(file);
    await this.counters.add(principal.userId, 'upload', 1);

    const objectKey = `${principal.orgId}/${principal.userId}/private/file-${randomUUID()}`;
    const stagingKey = toStagingKey(objectKey);
    await this.objects.putObject(stagingKey, file.buffer, {
      contentType,
      metadata: {
        'original-filename': encodeURIComponent(file.originalName),
        'owner-id': principal.userId,
        'uploaded-at': new Date().toISOString(),
      },
    });
    return { stagingKey, contentType, sizeBytes: file.buffer.length };
  }

  /**
   * Compensating delete for a staged transient object whose enqueue
   * transaction failed (the chat module's abort window). Staging keys only —
   * refusing anything else keeps this from ever deleting a durable original.
   */
  async deleteStagedTransient(stagingKey: string): Promise<void> {
    if (stagingKey.split('/')[2] !== 'staging') {
      throw untranslatedError.badRequest('not a staging key');
    }
    await this.cleanupOrphanObject(stagingKey);
  }

  /** Stored mode (F1 handoff §1): durable object + file_metadata row. */
  private async uploadStored(
    principal: Principal,
    file: UploadedFile,
    flags: UploadFlags,
    objectKey: string,
    contentType: string,
    /** Computed by `upload`, which needs it for the duplicate lookup too. */
    checksum: string,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    // (1) object-first.
    await this.objects.putObject(objectKey, file.buffer, {
      contentType,
      // Filename URL-encoded — S3 metadata must be US-ASCII; erased with the
      // bytes on deletion, so no schema of its own (handoff: no new columns).
      metadata: {
        'original-filename': encodeURIComponent(file.originalName),
        ...(options.gateFolder ? { 'gate-folder': encodeURIComponent(options.gateFolder) } : {}),
      },
    });

    try {
      // (2) metadata + enqueue in one transaction.
      await this.db.transaction(async (tx) => {
        await this.files.record(tx, {
          objectKey,
          ownerId: principal.userId,
          scope: flags.scope,
          sensitive: flags.sensitive,
          checksum,
          sizeBytes: file.buffer.length,
        });
        // The project, in the same transaction (V2.5 item 8.3): a source
        // that exists is a source whose project is already recorded.
        if (options.projectId && this.projects) {
          await this.projects.assignInTx(
            tx,
            principal.userId,
            { kind: 'source', refType: 'file', refId: objectKey },
            options.projectId,
          );
        }
        await withTransactionalEnqueue(
          tx,
          {
            type: 'file.uploaded',
            payload: { source_type: 'file', source_id: objectKey, owner_id: principal.userId },
          },
          {
            type: INGESTION_PIPELINE_JOB_TYPE,
            payload: { source_type: 'file', source_id: objectKey },
            maxAttempts: FILE_PIPELINE_MAX_ATTEMPTS,
            priority: options.jobPriority,
          },
        );
      });
    } catch (error) {
      // (3) abort-window cleanup: the transaction left no metadata and no job,
      // so the object is a true orphan — remove it. Logged + retried
      // a swallowed failure here used to leave PII bytes in the bucket forever.
      await this.cleanupOrphanObject(objectKey);
      throw error;
    }

    return { objectKey };
  }

  /**
   * Extract-and-discard mode (F1 handoff §3): NO durable object, NO
   * file_metadata row. The bytes are staged at {org}/{user}/staging/file-{uuid}
   * (the object key's staging twin); the pipeline reads them, derives memories
   * with full provenance to the byte-less source key, and — in the SAME
   * transaction as those memories — schedules the staging object's deletion, so
   * the original is discarded only after extraction is durable (no memory-loss
   * window). A delayed backstop cleanup guarantees the staging bytes go even if
   * extraction never succeeds (corrupt file / crash); absent = success. Staging
   * keys never enter file_metadata, provenance, or any receipt.
   */
  private async uploadDiscard(
    principal: Principal,
    file: UploadedFile,
    flags: UploadFlags,
    objectKey: string,
    contentType: string,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    const stagingKey = toStagingKey(objectKey);

    // (1) stage the bytes, carrying the context the pipeline needs (there is no
    // file_metadata row to read it from): owner, scope, sensitive, upload time.
    await this.objects.putObject(stagingKey, file.buffer, {
      contentType,
      metadata: {
        'original-filename': encodeURIComponent(file.originalName),
        'owner-id': principal.userId,
        scope: flags.scope,
        sensitive: String(flags.sensitive),
        'uploaded-at': new Date().toISOString(),
      },
    });

    try {
      // (2) enqueue the pipeline job + the delayed backstop cleanup in one tx.
      await this.db.transaction(async (tx) => {
        await withTransactionalEnqueue(
          tx,
          {
            type: 'file.uploaded',
            payload: {
              source_type: 'file',
              source_id: objectKey,
              owner_id: principal.userId,
              discard: true,
            },
          },
          {
            type: INGESTION_PIPELINE_JOB_TYPE,
            payload: { source_type: 'file', source_id: objectKey },
            maxAttempts: FILE_PIPELINE_MAX_ATTEMPTS,
            priority: options.jobPriority,
          },
        );
        // Backstop: fires in 15 min even if extraction never succeeds; the
        // success path also enqueues an immediate cleanup, so the norm is fast.
        // Through infrastructure's delayed-enqueue (B20 closed): the queue
        // schema is named only by its owner.
        await enqueueDelayedJob(
          tx,
          {
            type: FILE_DISCARD_CLEANUP_JOB_TYPE,
            payload: { source_type: 'file', source_id: stagingKey },
            maxAttempts: 5,
          },
          STAGING_BACKSTOP_MINUTES,
        );
      });
    } catch (error) {
      // Abort-window cleanup: no job enqueued, so the staging object is a true
      // orphan — remove it. Logged + retried; the sweep's orphan arm
      // is the backstop if every attempt fails.
      await this.cleanupOrphanObject(stagingKey);
      throw error;
    }

    return { objectKey };
  }

  /**
   * Reads a source again (V2.1 item 4.1).
   *
   * The point of retaining the original bytes is that an unreadable document is
   * only unreadable FOR NOW. A scan that needed vision on an instance that had
   * none becomes readable the moment vision is configured, and without an
   * explicit action it would stay unread forever while the capability sits
   * there working.
   *
   * Owner-gated, audited, and it goes through the NORMAL pipeline: the same
   * stages, the same verification, and the same reconciliation, which is what
   * makes a re-read produce supersessions and merges rather than a second copy
   * of every fact. Nothing here special-cases the second run.
   */
  async reprocess(principal: Principal, objectKey: string): Promise<{ queued: boolean } | null> {
    const metadata = await this.files.get(objectKey);
    const ownerId =
      metadata?.ownerId ?? (await this.memory.describeSource('file', objectKey))?.ownerId ?? null;
    if (!ownerId || ownerId !== principal.userId) return null;
    // A discarded original has no bytes to re-read; saying so is better than
    // queueing a job that can only fail.
    if (!metadata && !(await this.objects.statObject(objectKey))) return { queued: false };

    await this.db.transaction(async (tx) => {
      await clearIdempotencyForReprocess(tx, {
        sourceType: 'file',
        sourceId: objectKey,
        jobType: INGESTION_PIPELINE_JOB_TYPE,
      });
      await withTransactionalEnqueue(
        tx,
        {
          type: 'file.reprocess_requested',
          payload: { source_type: 'file', source_id: objectKey, owner_id: principal.userId },
        },
        {
          type: INGESTION_PIPELINE_JOB_TYPE,
          payload: { source_type: 'file', source_id: objectKey },
          maxAttempts: FILE_PIPELINE_MAX_ATTEMPTS,
        },
      );
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'file.reprocess_requested',
        entityType: 'file',
        entityId: objectKey,
        detail: { reason: 'capability_available' },
        orgId: principal.orgId,
        ownerId: principal.userId,
      });
    });
    return { queued: true };
  }

  /** Sources this owner has that could not be read for want of a capability. */
  async awaitingCapability(principal: Principal): Promise<AwaitingCapabilityDto[]> {
    return this.readReports.awaitingCapability(principal.userId);
  }

  /**
   * The read report alone, without the object HEAD `getSourceForOwner` pays —
   * for surfaces that already gated the source (the chat attachment card).
   */
  async getReadReport(objectKey: string): Promise<FileReadReportDto | null> {
    return this.readReports.get(objectKey);
  }

  /** The source drawer's file facts — owner-only (null → the controller 404s). */
  async getSourceForOwner(principal: Principal, objectKey: string): Promise<FileSourceDto | null> {
    const metadata = await this.files.get(objectKey);
    if (metadata) {
      if (metadata.ownerId !== principal.userId) return null;
      const stat = await this.objects.statObject(objectKey);
      const rawFilename = stat?.metadata['original-filename'] ?? null;
      // Owner-gated above; the read report is as visible as its source.
      const read = await this.readReports.get(objectKey);
      return {
        objectKey,
        filename: rawFilename ? safeDecode(rawFilename) : null,
        contentType: stat?.contentType ?? null,
        sizeBytes: stat?.sizeBytes ?? metadata.sizeBytes ?? null,
        scope: metadata.scope,
        sensitive: metadata.sensitive,
        uploadDate: metadata.uploadDate.toISOString(),
        state: await this.getProcessingState(objectKey),
        discarded: false,
        read,
      };
    }

    // No file_metadata: either a discarded source (its byte-less memories still
    // carry this key as provenance) or nonexistent. Authorization + the drawer
    // facts fall back to the derived memories (F1 handoff §3).
    const derived = await this.memory.describeSource('file', objectKey);
    if (!derived || derived.ownerId !== principal.userId) return null;
    return {
      objectKey,
      filename: null,
      contentType: null,
      sizeBytes: null,
      scope: derived.scope,
      sensitive: derived.sensitive,
      uploadDate: derived.createdAt.toISOString(),
      state: await this.getProcessingState(objectKey),
      discarded: true,
      // A discarded original has no bytes left; the read report is the only
      // remaining account of what was read out of them.
      read: await this.readReports.get(objectKey),
    };
  }

  /**
   * A short-lived signed download URL, or null when the caller may not
   * have it. Owner always; a non-owner only for a SHARED, NON-sensitive file in
   * their own org — sensitive files never leave their owner.
   *
   * AUDITED (V2.0 item 3.7). Minting a presigned URL is the moment a stored
   * original becomes reachable outside the instance, and it was the one egress
   * path in the product that wrote no audit row — the passport export's
   * equivalent has been audited since SEC-9. Structural metadata only: the
   * object key (an identifier, and the same one `integrity_alert` already
   * records), the TTL, and whether the caller was the owner or a same-org peer
   * reading a shared file, which is the fact worth being able to look up later.
   * A refusal writes nothing: there was no egress.
   */
  async getDownloadUrl(
    principal: Principal,
    objectKey: string,
  ): Promise<{ url: string; expiresInSeconds: number } | null> {
    const metadata = await this.files.get(objectKey);
    if (!metadata) return null;

    const isOwner = metadata.ownerId === principal.userId;
    const sameOrg = objectKey.split('/')[0] === principal.orgId;
    const shareable = metadata.scope === 'shared' && !metadata.sensitive && sameOrg;
    if (!isOwner && !shareable) return null;

    const stat = await this.objects.statObject(objectKey);
    if (!stat) return null; // no durable object (discarded / already deleted)
    const rawFilename = stat.metadata['original-filename'];
    const url = this.objects.presignGetUrl(objectKey, this.options.downloadUrlTtlSeconds, {
      filename: rawFilename ? safeDecode(rawFilename) : undefined,
      contentType: stat.contentType ?? undefined,
    });
    await writeAudit(this.db, {
      actor: `user:${principal.userId}`,
      action: 'file.downloaded',
      entityType: 'file',
      entityId: objectKey,
      detail: {
        ttlSeconds: this.options.downloadUrlTtlSeconds,
        byOwner: isOwner,
        scope: metadata.scope,
        sensitive: metadata.sensitive,
      },
      orgId: principal.orgId,
      // The FILE's owner, not the caller: the detail gate serves the person
      // whose artifact left, which is the point of recording it.
      ownerId: metadata.ownerId,
    });
    return { url, expiresInSeconds: this.options.downloadUrlTtlSeconds };
  }

  /**
   * The per-upload processing indicator's state — owner-only, and crucially
   * available BEFORE any memory or file_metadata exists (a discard-mode upload
   * has neither until extraction commits). Authorization is by the object key
   * itself: {orgId}/{userId}/… is minted for the uploader, so the key encodes
   * its owner. Null → the controller 404s.
   */
  async getUploadState(
    principal: Principal,
    objectKey: string,
  ): Promise<FileProcessingState | null> {
    const parts = objectKey.split('/');
    if (parts[0] !== principal.orgId || parts[1] !== principal.userId) return null;
    return this.getProcessingState(objectKey);
  }

  /**
   * Pipeline progress from the queue's own ledgers (no extra bookkeeping, same
   * as notes): a job_execution idempotency row means the pipeline committed; a
   * dead_letter row means it exhausted its retries (a corrupt file); otherwise
   * it is still queued/extracting/deriving.
   */
  async getProcessingState(objectKey: string): Promise<FileProcessingState> {
    const state = await jobRunState(this.db, {
      sourceType: 'file',
      sourceId: objectKey,
      jobType: INGESTION_PIPELINE_JOB_TYPE,
    });
    // A file's exhausted pipeline job reads as 'error' on this surface (a
    // corrupt file), not 'failed': FileProcessingState has its own vocabulary.
    return state === 'failed' ? 'error' : state;
  }

  /**
   * Validates the type at the boundary: the declared MIME must be accepted, and
   * the magic bytes must corroborate it (or, when the client sent a generic
   * type, name the type on their behalf). Returns the content type to store.
   *
   * **The bytes are the authority** (V2.1 item 4.1, issue A1). A declared type
   * only survives when the bytes agree with it or say nothing at all, which is
   * what makes a mislabelled upload either route correctly or be refused rather
   * than trusted. Two consequences worth naming:
   *
   * - DOCX and XLSX are both ZIP containers, so `sniffContentType` inspects the
   *   package entries. A workbook uploaded as a document is now stored as a
   *   workbook instead of failing at parse time.
   * - CSV has no magic bytes, so it is the one type accepted on its label. The
   *   label a browser sends for a `.csv` is unreliable (Windows reports
   *   `application/vnd.ms-excel` whenever Excel owns the extension), so the
   *   EXTENSION resolves those aliases, and only when the bytes are not some
   *   other format we recognise.
   */
  private resolveContentType(file: UploadedFile): string {
    const declared = file.mimeType.split(';')[0]!.trim().toLowerCase();
    const sniffed = sniffContentType(file.buffer);
    if (sniffed) {
      // The bytes named a format. If the label disagrees, the bytes win; if the
      // label is one we accept and matches, nothing changes.
      if (!ALLOWED_UPLOAD_CONTENT_TYPES.includes(sniffed)) {
        throw unsupportedType(file.mimeType);
      }
      return sniffed;
    }
    // No signature in the bytes. Only a text format can legitimately look like
    // this, so accept the declared CSV type, or a `.csv` name whose declared
    // type is one of the aliases a browser really sends.
    if (declared === CSV_CONTENT_TYPE) return CSV_CONTENT_TYPE;
    const isCsvName = /\.(csv|tsv)$/i.test(file.originalName);
    if (isCsvName && (declared === '' || CSV_ALIAS_CONTENT_TYPES.includes(declared))) {
      return CSV_CONTENT_TYPE;
    }
    // The other signature-less formats: markdown and plain text (V2.5 item
    // 8.2, the text reader). A declared markdown type is trusted as CSV's is;
    // plain text needs a text-looking name so a mislabelled binary still
    // refuses; an unlabeled `.md`/`.txt` resolves like the CSV aliases do.
    if (declared === MARKDOWN_CONTENT_TYPE) return MARKDOWN_CONTENT_TYPE;
    const isTextName = /\.(md|markdown|txt)$/i.test(file.originalName);
    if (declared === PLAIN_TEXT_CONTENT_TYPE && isTextName) return PLAIN_TEXT_CONTENT_TYPE;
    if (isTextName && (declared === '' || declared === 'application/octet-stream')) {
      return MARKDOWN_CONTENT_TYPE;
    }
    throw unsupportedType(file.mimeType);
  }
}

/** One refusal for every rejected type, naming what IS accepted. */
function unsupportedType(declaredType: string): HttpException {
  return userError.badRequest(
    'file.unsupportedType',
    "unsupported file type '{{type}}': only PDF, DOCX, XLSX, CSV, Markdown, plain text and images are accepted",
    { type: declaredType },
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
