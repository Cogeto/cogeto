import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { FileProcessingState, FileSourceDto, MemoryScope, Principal } from '@cogeto/shared';
import { ALLOWED_UPLOAD_CONTENT_TYPES } from '@cogeto/shared';
import {
  deadLetter,
  DRIZZLE,
  jobExecution,
  withTransactionalEnqueue,
} from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { INGESTION_PIPELINE_JOB_TYPE } from '../ingestion/index';
import { MemoryFileStore, MemoryObjectStore } from '../memory/index';
import { sniffContentType } from './document-extract';
import { FILE_UPLOAD_OPTIONS } from './file-upload-options';
import type { FileUploadOptions } from './file-upload-options';

/**
 * A permanent parse error still consumes retries, so file pipeline jobs cap
 * attempts low: a transient object-store blip gets a couple of retries, a
 * corrupt document reaches its `error` state promptly (notes keep the default
 * 10 — a note never "fails to parse").
 */
const FILE_PIPELINE_MAX_ATTEMPTS = 3;

export interface UploadedFile {
  buffer: Buffer;
  originalName: string;
  /** The client-declared MIME type; cross-checked against the magic bytes. */
  mimeType: string;
}

export interface UploadFlags {
  scope: MemoryScope;
  sensitive: boolean;
}

/**
 * The file source (F1 handoff) — the notes source's sibling in connectors, but
 * its bytes and metadata live in the memory module (decision 0003 ruling 2), so
 * this orchestrates the memory module's object store + file-metadata port and
 * the shared outbox; it owns no table of its own.
 *
 * Transactional ingestion (§A.3, handoff §1) — the safe order:
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
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly objects: MemoryObjectStore,
    private readonly files: MemoryFileStore,
    @Inject(FILE_UPLOAD_OPTIONS) private readonly options: FileUploadOptions,
  ) {}

  async upload(
    principal: Principal,
    file: UploadedFile,
    flags: UploadFlags,
  ): Promise<{ objectKey: string }> {
    if (file.buffer.length === 0) throw new BadRequestException('the uploaded file is empty');
    if (file.buffer.length > this.options.uploadMaxBytes) {
      throw new BadRequestException(
        `file exceeds the ${this.options.uploadMaxBytes}-byte upload limit`,
      );
    }
    const contentType = this.resolveContentType(file);

    // Object key contract (§A.6, handoff §1): {orgId}/{userId}/{scope}/file-{uuid},
    // first segment the Zitadel org id — minted before anything is written, the
    // provenance anchor of every derived memory.
    const objectKey = `${principal.orgId}/${principal.userId}/${flags.scope}/file-${randomUUID()}`;
    const checksum = createHash('sha256').update(file.buffer).digest('hex');

    // (1) object-first.
    await this.objects.putObject(objectKey, file.buffer, {
      contentType,
      // Filename URL-encoded — S3 metadata must be US-ASCII; erased with the
      // bytes on deletion, so no schema of its own (handoff: no new columns).
      metadata: { 'original-filename': encodeURIComponent(file.originalName) },
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
          },
        );
      });
    } catch (error) {
      // (3) abort-window cleanup: the transaction left no metadata and no job,
      // so the object is a true orphan — remove it (absent = success).
      await this.objects.deleteObject(objectKey).catch(() => undefined);
      throw error;
    }

    return { objectKey };
  }

  /** The source drawer's file facts — owner-only (null → the controller 404s). */
  async getSourceForOwner(principal: Principal, objectKey: string): Promise<FileSourceDto | null> {
    const metadata = await this.files.get(objectKey);
    if (!metadata || metadata.ownerId !== principal.userId) return null;

    const stat = await this.objects.statObject(objectKey);
    const rawFilename = stat?.metadata['original-filename'] ?? null;
    return {
      objectKey,
      filename: rawFilename ? safeDecode(rawFilename) : null,
      contentType: stat?.contentType ?? null,
      sizeBytes: stat?.sizeBytes ?? metadata.sizeBytes ?? null,
      scope: metadata.scope,
      sensitive: metadata.sensitive,
      uploadDate: metadata.uploadDate.toISOString(),
      state: await this.getProcessingState(objectKey),
    };
  }

  /**
   * A short-lived signed download URL (§A.9), or null when the caller may not
   * have it. Owner always; a non-owner only for a SHARED, NON-sensitive file in
   * their own org — sensitive files never leave their owner (decision 0003).
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
    return { url, expiresInSeconds: this.options.downloadUrlTtlSeconds };
  }

  /**
   * Pipeline progress from the queue's own ledgers (no extra bookkeeping, same
   * as notes): a job_execution idempotency row means the pipeline committed; a
   * dead_letter row means it exhausted its retries (a corrupt file); otherwise
   * it is still queued/extracting/deriving.
   */
  async getProcessingState(objectKey: string): Promise<FileProcessingState> {
    const done = await this.db
      .select({ id: jobExecution.id })
      .from(jobExecution)
      .where(
        and(
          eq(jobExecution.sourceType, 'file'),
          eq(jobExecution.sourceId, objectKey),
          eq(jobExecution.jobType, INGESTION_PIPELINE_JOB_TYPE),
        ),
      )
      .limit(1);
    if (done.length > 0) return 'done';

    const failed = await this.db
      .select({ id: deadLetter.id })
      .from(deadLetter)
      .where(
        and(
          eq(deadLetter.jobType, INGESTION_PIPELINE_JOB_TYPE),
          sql`${deadLetter.payload}->>'source_id' = ${objectKey}`,
        ),
      )
      .limit(1);
    return failed.length > 0 ? 'error' : 'processing';
  }

  /**
   * Validates the type at the boundary: the declared MIME must be accepted, and
   * the magic bytes must corroborate it (or, when the client sent a generic
   * type, name the type on their behalf). Returns the content type to store.
   */
  private resolveContentType(file: UploadedFile): string {
    const declared = file.mimeType.split(';')[0]!.trim().toLowerCase();
    const sniffed = sniffContentType(file.buffer);
    if (ALLOWED_UPLOAD_CONTENT_TYPES.includes(declared)) {
      // Guard against a mismatched extension/content: if the bytes sniff to a
      // DIFFERENT allowed type, trust the bytes.
      return sniffed && sniffed !== declared ? sniffed : declared;
    }
    if (sniffed) return sniffed;
    throw new BadRequestException(
      `unsupported file type '${file.mimeType}' — only PDF and DOCX are accepted`,
    );
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
