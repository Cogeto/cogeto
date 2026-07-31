import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import { DRIZZLE, loadInstanceSigner, writeAudit } from '../infrastructure/index';
import type { Db, InstanceSigner } from '../infrastructure/index';
import { MemoryFileStore, MemoryObjectStore, MemoryStore, type MemoryRow } from '../memory/index';
import { UserDirectory } from '../identity/index';
import { assemblePassport } from './passport-assembler';
import type { ZipEntry } from './zip';
import type { MemoryExport } from './passport-format';
import { PASSPORT_PATHS } from './passport-format';
import { PassportExportStore } from './passport.store';
import { PASSPORT_OPTIONS } from './passport.options';
import type { PassportOptions } from './passport.options';

/** Owner principal reconstructed from the export row — the export re-reads
 * through the SAME gated interfaces, so it can only ever include what this user
 * may see (the passport_gating contract). Only fields the gated reads use. */
function ownerPrincipal(userId: string, orgId: string | null): Principal {
  return { userId, name: '', email: null, orgId: orgId ?? '', orgName: '', roles: [] };
}

/**
 * The Memory Passport export job (spec §11.4) — worker-run because it
 * can be large (spec §15.4: slow-path work never blocks a request). It re-reads
 * everything through the Principal-gated interfaces (MemoryStore and the
 * owner-scoped receipts read), assembles the signed artifact, and stores it
 * as a short-lived, owner-scoped object. A user can only ever export what they
 * are entitled to see — enforced by the same gates as every other read.
 */
@Injectable()
export class PassportExportExecutor {
  private readonly logger = new Logger(PassportExportExecutor.name);
  private signer?: InstanceSigner;

  constructor(
    private readonly memory: MemoryStore,
    private readonly objects: MemoryObjectStore,
    private readonly files: MemoryFileStore,
    private readonly store: PassportExportStore,
    private readonly directory: UserDirectory,
    @Inject(PASSPORT_OPTIONS) private readonly options: PassportOptions,
    // Appended LAST on purpose: every other constructor argument keeps its
    // position, so no existing wiring or test double shifts.
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  /** Assemble and store the artifact for one export request. Idempotent: a
   * retry overwrites the same object key and re-marks the row ready. */
  async run(
    exportId: string,
    now: Date,
  ): Promise<{ objectKey: string; sizeBytes: number; published: boolean }> {
    const request = await this.store.getById(exportId);
    if (!request) throw new Error(`passport export ${exportId} not found`);
    const principal = ownerPrincipal(request.userId, request.orgId);

    // Gated reads — the export is exactly what this principal may see.
    const [memoryRows, receipts] = await Promise.all([
      this.memory.listAllForPrincipal(principal, { includeSensitive: true }),
      this.memory.confirmedReceiptsForOwner(principal.userId),
    ]);

    // Resolve file provenance + (optionally) original bytes for the user's OWN
    // file uploads only — a teammate's shared file fact stays reference-only, so
    // no other user's original bytes ever enter the archive.
    const ownFileKeys = [
      ...new Set(
        memoryRows
          .filter((m) => m.sourceType === 'file' && m.ownerId === principal.userId)
          .map((m) => m.sourceId),
      ),
    ];
    const fileInfo = new Map<string, FileInfo>();
    const attachments: ZipEntry[] = [];
    for (const key of ownFileKeys) {
      const info = await this.resolveFile(key, request.includeOriginals);
      if (!info) continue;
      fileInfo.set(key, info);
      if (info.attachment) attachments.push(info.attachment);
    }

    const memories = memoryRows.map((row) =>
      toMemoryExport(
        row,
        principal.userId,
        row.ownerId === principal.userId ? (fileInfo.get(row.sourceId) ?? null) : null,
      ),
    );

    const displayName =
      (await this.directory.displayNames([principal.userId])).get(principal.userId) ?? null;
    const signer = await this.getSigner();
    const { zip, sizeBytes } = assemblePassport({
      subject: { userId: principal.userId, displayName },
      memories,
      receipts,
      attachments,
      instancePublicKeyPem: signer.publicKeyPem,
      includeOriginals: request.includeOriginals,
      generatedAt: now,
      sign: (bytes) => signer.sign(bytes),
    });

    const objectKey = this.objectKeyFor(principal, exportId);
    await this.objects.putObject(objectKey, zip, { contentType: 'application/zip' });
    const expiresAt = new Date(now.getTime() + this.options.exportRetentionHours * 3_600_000);
    const published = await this.store.markReady(exportId, objectKey, sizeBytes, now, expiresAt);
    if (!published) {
      // SEC-8: a source deletion expired this export while we were assembling
      // it, so the bytes we just wrote describe memory the receipt already
      // promised erased. The row stays expired; erase the object ourselves,
      // because it was written after the saga enumerated and so is in no
      // receipt for the worker leg or the sweep to catch.
      await this.objects.deleteObject(objectKey);
      this.logger.log(
        `passport export ${exportId} was expired by a source deletion while assembling: ` +
          `object discarded, export not published`,
      );
      return { objectKey, sizeBytes, published: false };
    }
    // SEC-9: the artifact now exists and is downloadable. Structural only.
    await writeAudit(this.db, {
      actor: 'passport_export',
      action: 'passport.export_ready',
      entityType: 'passport_export',
      entityId: exportId,
      detail: { sizeBytes, expiresAt: expiresAt.toISOString() },
      ownerId: request.userId,
    });
    this.logger.log(
      `passport export ${exportId} ready: ${memories.length} memories, ` +
        `${receipts.length} receipts, ${attachments.length} attachments, ${sizeBytes} bytes`,
    );
    return { objectKey, sizeBytes, published: true };
  }

  async fail(exportId: string, error: string): Promise<void> {
    await this.store.markFailed(exportId, error);
  }

  /** The recurring retention pass: delete expired export objects, mark rows. */
  async runRetention(now: Date): Promise<{ expired: number }> {
    const expired = await this.store.listExpired(now);
    for (const row of expired) {
      if (row.objectKey) await this.objects.deleteObject(row.objectKey);
      await this.store.markExpired(row.id);
    }
    return { expired: expired.length };
  }

  private objectKeyFor(principal: Principal, exportId: string): string {
    const org = principal.orgId || 'instance';
    return `${org}/${principal.userId}/exports/passport-${exportId}.zip`;
  }

  private async resolveFile(
    objectKey: string,
    includeOriginals: boolean,
  ): Promise<FileInfo | null> {
    const meta = await this.files.get(objectKey);
    if (!meta) return null;
    const stat = await this.objects.statObject(objectKey);
    const filename = stat?.metadata['filename']
      ? decodeURIComponent(stat.metadata['filename'])
      : null;
    const info: FileInfo = {
      filename,
      contentType: stat?.contentType ?? null,
      sizeBytes: stat?.sizeBytes ?? meta.sizeBytes,
      attachment: null,
      attachmentPath: null,
    };
    if (includeOriginals) {
      const object = await this.objects.getObject(objectKey);
      const base = objectKey.split('/').pop() ?? 'file';
      const safe = filename ? filename.replace(/[^\w.\- ]+/g, '_') : 'original';
      const path = `${PASSPORT_PATHS.attachmentsDir}/files/${base}-${safe}`;
      info.attachment = { path, data: object.body };
      info.attachmentPath = path;
    }
    return info;
  }

  private async getSigner(): Promise<InstanceSigner> {
    this.signer ??= await loadInstanceSigner(this.options.instanceKeyDir);
    return this.signer;
  }
}

interface FileInfo {
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  attachment: ZipEntry | null;
  attachmentPath: string | null;
}

/** Row → export document entry. Pure — the executor did the gated read. */
export function toMemoryExport(
  row: MemoryRow,
  subjectUserId: string,
  file: FileInfo | null,
): MemoryExport {
  return {
    id: row.id,
    content: row.content,
    status: row.status,
    scope: row.scope,
    sensitive: row.sensitive,
    owner_id: row.ownerId,
    owned_by_me: row.ownerId === subjectUserId,
    entities: row.entities,
    subject_entity: row.subjectEntity,
    kind: row.kind,
    valid_from: row.validFrom?.toISOString() ?? null,
    valid_until: row.validUntil?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt?.toISOString() ?? null,
    superseded_by: row.supersededBy,
    temporal_unresolved: row.temporalUnresolved,
    provenance: {
      source_type: row.sourceType,
      source_id: row.sourceId,
      context: null,
      file: file
        ? { filename: file.filename, content_type: file.contentType, size_bytes: file.sizeBytes }
        : null,
      attachment_path: file?.attachmentPath ?? null,
    },
  };
}
