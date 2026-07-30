import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PassportDownloadDto, PassportExportDto, Principal } from '@cogeto/shared';
import { DRIZZLE, withTransactionalEnqueue, writeAudit } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { MemoryObjectStore } from '../memory/index';
import { PassportExportStore, PASSPORT_EXPORT_JOB_TYPE, toExportDto } from './passport.store';
import { PASSPORT_OPTIONS } from './passport.options';
import type { PassportOptions } from './passport.options';

/**
 * The Memory Passport surface (spec §11.4) — trigger an export, poll
 * its status, and hand back a short-lived signed download URL. Assembly is a
 * worker job (spec §15.4); this service only creates the request (transactionally
 * enqueuing the job) and reads owner-scoped status.
 */
@Injectable()
export class PassportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly store: PassportExportStore,
    private readonly objects: MemoryObjectStore,
    @Inject(PASSPORT_OPTIONS) private readonly options: PassportOptions,
  ) {}

  /**
   * Trigger an export. At most one in-flight export per user: a pending request
   * is returned as-is rather than queuing another (cheap anti-spam; the artifact
   * is the same data either way).
   */
  async trigger(principal: Principal, includeOriginals: boolean): Promise<PassportExportDto> {
    const existing = (await this.store.listForOwner(principal.userId)).find(
      (row) => row.status === 'pending',
    );
    if (existing) return toExportDto(existing);

    const row = await this.db.transaction(async (tx) => {
      const created = await this.store.createInTx(
        tx,
        principal.userId,
        principal.orgId || undefined,
        includeOriginals,
      );
      await withTransactionalEnqueue(
        tx,
        {
          type: 'passport.export_requested',
          payload: { export_id: created.id, owner_id: principal.userId },
        },
        {
          type: PASSPORT_EXPORT_JOB_TYPE,
          payload: { source_type: 'passport', source_id: created.id },
        },
      );
      // SEC-9: a passport export is the single highest-impact data movement in
      // the product, a signed copy of everything one user can see. It used to
      // leave no entry at all in the append-only trail the product markets as
      // its inspectability guarantee. Structural metadata only, per the audit
      // writer contract: ids and flags, never content.
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'passport.export_requested',
        entityType: 'passport_export',
        entityId: created.id,
        detail: { includeOriginals },
        orgId: principal.orgId,
        ownerId: principal.userId,
      });
      return created;
    });
    return toExportDto(row);
  }

  async list(principal: Principal): Promise<PassportExportDto[]> {
    return (await this.store.listForOwner(principal.userId)).map(toExportDto);
  }

  async get(principal: Principal, id: string): Promise<PassportExportDto> {
    const row = await this.store.getForOwner(principal.userId, id);
    if (!row) throw new NotFoundException(`export ${id} not found`);
    return toExportDto(row);
  }

  /** A short-lived signed download URL — owner-gated, only for a ready export. */
  async download(principal: Principal, id: string): Promise<PassportDownloadDto> {
    const row = await this.store.getForOwner(principal.userId, id);
    if (!row) throw new NotFoundException(`export ${id} not found`);
    // SEC-8: an export expired by a source deletion must never mint another
    // URL. Its bytes are erased by the same receipt that erased the source, so
    // say plainly why rather than reporting a generic "not ready".
    if (row.status === 'expired') {
      throw new BadRequestException(
        `export ${id} is no longer available: it was expired because a source it may have ` +
          `contained was deleted. Request a new export.`,
      );
    }
    if (row.status !== 'ready' || !row.objectKey) {
      throw new BadRequestException(`export ${id} is not ready to download`);
    }
    const ttl = this.options.downloadUrlTtlSeconds;
    const url = this.objects.presignGetUrl(row.objectKey, ttl, {
      filename: toExportDto(row).filename,
      contentType: 'application/zip',
    });
    // SEC-9: the egress itself is the event worth recording. A presigned URL is
    // the moment the bytes become reachable outside the instance.
    await writeAudit(this.db, {
      actor: `user:${principal.userId}`,
      action: 'passport.export_downloaded',
      entityType: 'passport_export',
      entityId: id,
      detail: { ttlSeconds: ttl, sizeBytes: row.sizeBytes ?? null },
      orgId: principal.orgId,
      ownerId: principal.userId,
    });
    return { url, expiresInSeconds: ttl };
  }
}
