import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PassportDownloadDto, PassportExportDto, Principal } from '@cogeto/shared';
import { DRIZZLE, withTransactionalEnqueue } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { MemoryObjectStore } from '../memory/index';
import { PassportExportStore, PASSPORT_EXPORT_JOB_TYPE, toExportDto } from './passport.store';
import { PASSPORT_OPTIONS } from './passport.options';
import type { PassportOptions } from './passport.options';

/**
 * The Memory Passport surface (§B.5, decision 0029) — trigger an export, poll
 * its status, and hand back a short-lived signed download URL. Assembly is a
 * worker job (§A.3); this service only creates the request (transactionally
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
    if (row.status !== 'ready' || !row.objectKey) {
      throw new BadRequestException(`export ${id} is not ready to download`);
    }
    const ttl = this.options.downloadUrlTtlSeconds;
    const url = this.objects.presignGetUrl(row.objectKey, ttl, {
      filename: toExportDto(row).filename,
      contentType: 'application/zip',
    });
    return { url, expiresInSeconds: ttl };
  }
}
