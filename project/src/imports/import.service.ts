import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type {
  FolderManifestRequest,
  ImportItemDto,
  ImportProgressDto,
  ImportRunDetailDto,
  ImportRunDto,
  Principal,
  S3ManifestRequest,
} from '@cogeto/shared';
import { DRIZZLE, withTransactionalEnqueue } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { checksumsKnownForOwner, listFileSourceRefs, MemoryObjectStore } from '../memory/index';
import { sniffContentType } from '../files/index';
import { normalizeFilename } from '../ingestion/index';
import { importItem, importRun } from './persistence/tables';
import type { ImportItemRow, ImportRunRow } from './persistence/tables';
import { zipEntries, zipExtract } from './zip';
import { IMPORT_ADVANCE_JOB_TYPE } from './import-jobs';

/** ZIP archives may exceed the single-upload cap; their ENTRIES still face
 * the normal per-file validation when ingested. */
export const IMPORT_ZIP_MAX_BYTES_DEFAULT = 200 * 1024 * 1024;

/** Manifest size bound: an import beyond this needs to be split. */
const MAX_MANIFEST_ITEMS = 20_000;

/** The staging twin's segment is `staging`, inheriting every existing rule:
 * staging keys never enter provenance, receipts, or the sweep's view. */
const stagingKeyFor = (principal: Principal, runId: string, itemId: string): string =>
  `${principal.orgId}/${principal.userId}/staging/import-${runId}-${itemId}`;

/**
 * Bulk import (V2.2 item 5.3, issue A): manifest FIRST, nothing ingested
 * until confirmed, queued ingestion through the one existing pipeline.
 *
 * The two hash cases stay distinct (issue A2): content identical to a stored
 * source is a DUPLICATE (skipped, counted); same normalized filename with a
 * different hash is a REVISION CANDIDATE (ingested normally, nominated for
 * the conservative linker — docs/features/revisions.md).
 */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly objects: MemoryObjectStore,
  ) {}

  // ── Manifest creation ────────────────────────────────────────────────────

  /** A ZIP: staged whole, enumerated without inflation, entries hashed lazily
   * at confirm (extraction is when the bytes exist individually). */
  async createZipManifest(
    principal: Principal,
    zip: { buffer: Buffer; originalName: string },
  ): Promise<ImportRunDetailDto> {
    const entries = zipEntries(zip.buffer);
    if (!entries) throw new BadRequestException('not a readable ZIP archive');
    if (entries.length === 0) throw new BadRequestException('the archive contains no files');
    if (entries.length > MAX_MANIFEST_ITEMS) {
      throw new BadRequestException(`too many files (max ${MAX_MANIFEST_ITEMS}); split the import`);
    }
    const run = await this.insertRun(principal, 'zip', zip.originalName);
    // The archive itself is staged once; entries extract from it at confirm.
    await this.objects.putObject(this.zipStagingKey(principal, run.id), zip.buffer, {
      contentType: 'application/zip',
    });
    // Hash entries now (cheap, in-memory) so dedup shows in the manifest.
    const rows = entries.map((entry) => ({
      runId: run.id,
      ownerId: principal.userId,
      name: entry.name,
      sizeBytes: entry.uncompressedSize,
      contentHash: this.tryHash(zip.buffer, entry),
    }));
    await this.db.insert(importItem).values(rows);
    await this.classify(principal, run.id);
    return this.detail(principal, run.id);
  }

  /** A browser-enumerated folder: names, sizes and CLIENT-computed hashes
   * arrive first; the included files upload after the manifest is seen. */
  async createFolderManifest(
    principal: Principal,
    request: FolderManifestRequest,
  ): Promise<ImportRunDetailDto> {
    if (request.items.length === 0) throw new BadRequestException('the folder contains no files');
    if (request.items.length > MAX_MANIFEST_ITEMS) {
      throw new BadRequestException(`too many files (max ${MAX_MANIFEST_ITEMS}); split the import`);
    }
    const run = await this.insertRun(principal, 'folder', request.sourceLabel ?? null);
    await this.db.insert(importItem).values(
      request.items.map((item) => ({
        runId: run.id,
        ownerId: principal.userId,
        name: item.name,
        sizeBytes: item.sizeBytes,
        contentHash: item.contentHash.toLowerCase(),
      })),
    );
    await this.classify(principal, run.id);
    return this.detail(principal, run.id);
  }

  /** An S3-style path: listed with the caller's credentials, which are used
   * for the listing and DISCARDED; confirm carries them once more to copy
   * the selected objects into staging, after which nothing external remains. */
  async createS3Manifest(
    principal: Principal,
    request: S3ManifestRequest,
  ): Promise<ImportRunDetailDto> {
    const external = new MemoryObjectStore({
      url: request.url,
      accessKey: request.accessKey,
      secretKey: request.secretKey,
      bucket: request.bucket,
    });
    const objects = await external.listObjects(request.prefix);
    if (objects.length === 0) throw new BadRequestException('nothing under that prefix');
    if (objects.length > MAX_MANIFEST_ITEMS) {
      throw new BadRequestException(`too many files (max ${MAX_MANIFEST_ITEMS}); split the import`);
    }
    const run = await this.insertRun(
      principal,
      's3',
      `${request.url}/${request.bucket}/${request.prefix ?? ''}`,
    );
    await this.db.insert(importItem).values(
      objects.map((object) => ({
        runId: run.id,
        ownerId: principal.userId,
        name: object.key,
        sizeBytes: object.sizeBytes ?? null,
        // Hashes arrive when the bytes do (confirm); the manifest says so.
        contentHash: null,
      })),
    );
    await this.classify(principal, run.id);
    return this.detail(principal, run.id);
  }

  /** A folder item's bytes, uploaded after the manifest: staged, sniffed,
   * hash-verified against the manifest's claim. */
  async stageFolderItem(
    principal: Principal,
    runId: string,
    itemId: string,
    file: { buffer: Buffer; originalName: string; mimeType: string },
  ): Promise<ImportItemDto> {
    const run = await this.requireRun(principal, runId);
    if (run.state !== 'manifest') throw new BadRequestException('this import already started');
    const item = await this.requireItem(principal, runId, itemId);
    if (item.state !== 'listed') {
      throw new BadRequestException(`item is ${item.state}; only listed items take bytes`);
    }
    const hash = createHash('sha256').update(file.buffer).digest('hex');
    if (item.contentHash && hash !== item.contentHash) {
      throw new BadRequestException('uploaded bytes do not match the manifest hash');
    }
    const stagingKey = stagingKeyFor(principal, runId, itemId);
    await this.objects.putObject(stagingKey, file.buffer, {
      contentType: file.mimeType || 'application/octet-stream',
      metadata: { 'original-filename': encodeURIComponent(item.name ?? file.originalName) },
    });
    const sniffed = sniffContentType(file.buffer);
    const [updated] = await this.db
      .update(importItem)
      .set({
        stagingKey,
        contentHash: hash,
        contentType: sniffed ?? file.mimeType ?? null,
        updatedAt: new Date(),
      })
      .where(eq(importItem.id, itemId))
      .returning();
    return toItemDto(updated!);
  }

  // ── Manifest decisions ──────────────────────────────────────────────────

  async exclude(principal: Principal, runId: string, itemIds: string[]): Promise<void> {
    const run = await this.requireRun(principal, runId);
    if (run.state !== 'manifest') throw new BadRequestException('this import already started');
    if (itemIds.length === 0) return;
    await this.db
      .update(importItem)
      .set({ state: 'excluded', updatedAt: new Date() })
      .where(
        and(
          eq(importItem.runId, runId),
          inArray(importItem.id, itemIds),
          inArray(importItem.state, ['listed', 'duplicate', 'unsupported']),
        ),
      );
  }

  /**
   * Confirm: stage what is not yet staged (ZIP entries extract; S3 objects
   * copy with the re-supplied credentials; folder items must already have
   * their bytes), then hand the run to the worker-side coordinator. Nothing
   * before this point has ingested anything.
   */
  async confirm(
    principal: Principal,
    runId: string,
    options: { s3?: S3ManifestRequest } = {},
  ): Promise<ImportRunDto> {
    const run = await this.requireRun(principal, runId);
    if (run.state !== 'manifest') throw new BadRequestException('this import already started');
    const items = await this.itemsOf(runId);
    const pending = items.filter((item) => item.state === 'listed');
    if (pending.length === 0) throw new BadRequestException('nothing to import after exclusions');

    if (run.kind === 'zip') await this.stageZipEntries(principal, run, pending);
    if (run.kind === 's3') {
      if (!options.s3) throw new BadRequestException('S3 credentials are required to confirm');
      await this.stageS3Objects(principal, run, pending, options.s3);
      await this.classify(principal, runId); // hashes exist only now
    }
    if (run.kind === 'folder') {
      const unstaged = pending.filter((item) => !item.stagingKey);
      if (unstaged.length > 0) {
        throw new BadRequestException(`${unstaged.length} files have not finished uploading`);
      }
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(importRun)
        .set({ state: 'running', startedAt: new Date() })
        .where(eq(importRun.id, runId));
      await withTransactionalEnqueue(
        tx,
        {
          type: 'import.confirmed',
          payload: { source_type: 'import_run', source_id: runId, owner_id: principal.userId },
        },
        {
          type: IMPORT_ADVANCE_JOB_TYPE,
          payload: { source_type: 'import_run', source_id: runId },
          principalId: principal.userId,
        },
      );
    });
    return this.get(principal, runId);
  }

  /** Cancellation stops further queueing and keeps what was ingested. */
  async cancel(principal: Principal, runId: string): Promise<ImportRunDto> {
    const run = await this.requireRun(principal, runId);
    if (run.state === 'completed' || run.state === 'cancelled') return this.get(principal, runId);
    await this.db
      .update(importItem)
      .set({ state: 'cancelled', updatedAt: new Date() })
      .where(and(eq(importItem.runId, runId), inArray(importItem.state, ['listed'])));
    await this.db
      .update(importRun)
      .set({ state: 'cancelled', finishedAt: new Date() })
      .where(eq(importRun.id, runId));
    // The coordinator's next pass reaps in-flight items honestly and cleans
    // remaining staging; kick it in case none is pending.
    await this.db.transaction((tx) =>
      withTransactionalEnqueue(
        tx,
        {
          type: 'import.cancelled',
          payload: { source_type: 'import_run', source_id: runId, owner_id: principal.userId },
        },
        {
          type: IMPORT_ADVANCE_JOB_TYPE,
          payload: { source_type: 'import_run', source_id: runId },
        },
      ),
    );
    return this.get(principal, runId);
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async list(principal: Principal, limit = 20): Promise<ImportRunDto[]> {
    const runs = await this.db
      .select()
      .from(importRun)
      .where(eq(importRun.ownerId, principal.userId))
      .orderBy(sql`${importRun.createdAt} DESC`)
      .limit(Math.min(limit, 50));
    return Promise.all(runs.map((run) => this.toRunDto(run)));
  }

  async get(principal: Principal, runId: string): Promise<ImportRunDto> {
    const run = await this.requireRun(principal, runId);
    return this.toRunDto(run);
  }

  async detail(principal: Principal, runId: string): Promise<ImportRunDetailDto> {
    const run = await this.requireRun(principal, runId);
    const items = await this.itemsOf(runId);
    return { ...(await this.toRunDto(run)), items: items.map(toItemDto) };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async insertRun(
    principal: Principal,
    kind: 'zip' | 'folder' | 's3',
    sourceLabel: string | null,
  ): Promise<ImportRunRow> {
    const [run] = await this.db
      .insert(importRun)
      .values({
        ownerId: principal.userId,
        orgId: principal.orgId,
        kind,
        optionsJson: { sourceLabel: sourceLabel ?? undefined },
      })
      .returning();
    return run!;
  }

  /**
   * The two hash cases, never conflated (issue A2): a hash already in the
   * corpus is a DUPLICATE (skipped); a normalized filename already in the
   * corpus with a different hash nominates a REVISION candidate. Unsupported
   * extensions are labelled here so the manifest is honest about them.
   */
  private async classify(principal: Principal, runId: string): Promise<void> {
    const items = await this.itemsOf(runId);
    const hashes = items.map((item) => item.contentHash).filter((h): h is string => h !== null);
    const known = await checksumsKnownForOwner(this.db, principal.userId, hashes);
    const byName = await this.predecessorsByName(principal);
    for (const item of items) {
      if (item.state !== 'listed') continue;
      const supported = item.name !== null && looksSupported(item.name);
      if (!supported) {
        await this.setItem(item.id, { state: 'unsupported', reason: 'unsupported_type' });
        continue;
      }
      if (item.contentHash && known.has(item.contentHash)) {
        await this.setItem(item.id, { state: 'duplicate', reason: 'content_hash_match' });
        continue;
      }
      const predecessor = item.name ? byName.get(normalizeFilename(item.name)) : undefined;
      if (predecessor && item.contentHash && !known.has(item.contentHash)) {
        await this.setItem(item.id, { revisionOf: predecessor });
      }
    }
  }

  private async stageZipEntries(
    principal: Principal,
    run: ImportRunRow,
    pending: ImportItemRow[],
  ): Promise<void> {
    const archive = await this.objects.getObject(this.zipStagingKey(principal, run.id));
    const entries = zipEntries(archive.body);
    if (!entries) throw new BadRequestException('the staged archive is no longer readable');
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    for (const item of pending) {
      const entry = item.name ? byName.get(item.name) : undefined;
      if (!entry) {
        await this.setItem(item.id, { state: 'failed', reason: 'missing_in_archive' });
        continue;
      }
      try {
        const bytes = zipExtract(archive.body, entry);
        const stagingKey = stagingKeyFor(principal, run.id, item.id);
        await this.objects.putObject(stagingKey, bytes, {
          contentType: 'application/octet-stream',
          metadata: { 'original-filename': encodeURIComponent(item.name!) },
        });
        await this.setItem(item.id, {
          stagingKey,
          contentType: sniffContentType(bytes) ?? null,
        });
      } catch (error) {
        this.logger.warn(`zip extract failed for one entry: ${(error as Error).message}`);
        await this.setItem(item.id, { state: 'failed', reason: 'zip_extract_failed' });
      }
    }
    await this.objects.deleteObject(this.zipStagingKey(principal, run.id)).catch(() => undefined);
  }

  private async stageS3Objects(
    principal: Principal,
    run: ImportRunRow,
    pending: ImportItemRow[],
    credentials: S3ManifestRequest,
  ): Promise<void> {
    const external = new MemoryObjectStore({
      url: credentials.url,
      accessKey: credentials.accessKey,
      secretKey: credentials.secretKey,
      bucket: credentials.bucket,
    });
    for (const item of pending) {
      try {
        const object = await external.getObject(item.name!);
        const stagingKey = stagingKeyFor(principal, run.id, item.id);
        await this.objects.putObject(stagingKey, object.body, {
          contentType: object.contentType ?? 'application/octet-stream',
          metadata: { 'original-filename': encodeURIComponent(item.name!) },
        });
        await this.setItem(item.id, {
          stagingKey,
          contentHash: createHash('sha256').update(object.body).digest('hex'),
          contentType: sniffContentType(object.body) ?? object.contentType ?? null,
          sizeBytes: object.body.length,
        });
      } catch (error) {
        this.logger.warn(`s3 copy failed for one object: ${(error as Error).message}`);
        await this.setItem(item.id, { state: 'failed', reason: 's3_copy_failed' });
      }
    }
  }

  private zipStagingKey(principal: Principal, runId: string): string {
    return `${principal.orgId}/${principal.userId}/staging/import-archive-${runId}`;
  }

  private tryHash(archive: Buffer, entry: Parameters<typeof zipExtract>[1]): string | null {
    try {
      return createHash('sha256').update(zipExtract(archive, entry)).digest('hex');
    } catch {
      return null;
    }
  }

  private async setItem(
    itemId: string,
    patch: Partial<typeof importItem.$inferInsert>,
  ): Promise<void> {
    await this.db
      .update(importItem)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(importItem.id, itemId));
  }

  private async requireRun(principal: Principal, runId: string): Promise<ImportRunRow> {
    const rows = await this.db
      .select()
      .from(importRun)
      .where(and(eq(importRun.id, runId), eq(importRun.ownerId, principal.userId)))
      .limit(1);
    if (!rows[0]) throw new NotFoundException(`import ${runId} not found`);
    return rows[0];
  }

  private async requireItem(
    principal: Principal,
    runId: string,
    itemId: string,
  ): Promise<ImportItemRow> {
    const rows = await this.db
      .select()
      .from(importItem)
      .where(
        and(
          eq(importItem.id, itemId),
          eq(importItem.runId, runId),
          eq(importItem.ownerId, principal.userId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new NotFoundException(`import item ${itemId} not found`);
    return rows[0];
  }

  private async itemsOf(runId: string): Promise<ImportItemRow[]> {
    return this.db
      .select()
      .from(importItem)
      .where(eq(importItem.runId, runId))
      .orderBy(asc(importItem.name), asc(importItem.id));
  }

  /**
   * Existing file sources by normalized filename, for revision nomination.
   * Filenames live on the objects (never a column, by the deletion contract),
   * so this is a bounded parallel HEAD sweep over the owner's newest stored
   * uploads — capped, stated, and only run while building a manifest.
   */
  private async predecessorsByName(principal: Principal): Promise<Map<string, string>> {
    const refs = await listFileSourceRefs(this.db, principal.userId, { limit: 200 });
    // Newest wins for a name seen twice: a chain re-imports link to the tip.
    const out = new Map<string, string>();
    const stats = await Promise.all(
      refs.map(async (ref) => ({
        key: ref.objectKey,
        stat: await this.objects.statObject(ref.objectKey).catch(() => null),
      })),
    );
    for (const { key, stat } of stats.reverse()) {
      const raw = stat?.metadata['original-filename'];
      if (!raw) continue;
      try {
        out.set(normalizeFilename(decodeURIComponent(raw)), key);
      } catch {
        out.set(normalizeFilename(raw), key);
      }
    }
    return out;
  }

  private async toRunDto(run: ImportRunRow): Promise<ImportRunDto> {
    const grouped = await this.db
      .select({ state: importItem.state, n: sql<number>`count(*)::int` })
      .from(importItem)
      .where(eq(importItem.runId, run.id))
      .groupBy(importItem.state);
    const by = new Map(grouped.map((row) => [row.state, row.n]));
    const total = [...by.values()].reduce((a, b) => a + b, 0);
    const done = (by.get('ingested') ?? 0) + (by.get('tombstoned') ?? 0);
    const progress: ImportProgressDto = {
      total,
      done,
      failed: by.get('failed') ?? 0,
      inFlight: by.get('queued') ?? 0,
      remaining: by.get('listed') ?? 0,
      duplicates: by.get('duplicate') ?? 0,
      unsupported: by.get('unsupported') ?? 0,
      excluded: by.get('excluded') ?? 0,
      cancelled: by.get('cancelled') ?? 0,
    };
    return {
      id: run.id,
      kind: run.kind,
      state: run.state,
      sourceLabel: run.optionsJson?.sourceLabel ?? null,
      pausedReason: run.optionsJson?.pausedReason ?? null,
      counts: run.countsJson ?? null,
      progress,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
    };
  }
}

function toItemDto(row: ImportItemRow): ImportItemDto {
  return {
    id: row.id,
    name: row.name,
    sizeBytes: row.sizeBytes,
    contentType: row.contentType,
    state: row.state,
    reason: row.reason,
    revisionOf: row.revisionOf,
    objectKey: row.objectKey,
  };
}

/** Manifest-time supportability by extension: the honest label before bytes
 * exist; the byte-authoritative check still runs at ingestion. */
function looksSupported(name: string): boolean {
  return /\.(pdf|docx|xlsx|csv|tsv|png|jpe?g|webp|tiff?)$/i.test(name);
}
