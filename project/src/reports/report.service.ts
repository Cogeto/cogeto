import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  FindingsReportDto,
  Principal,
  ReportDownloadDto,
  ReportDownloadFormat,
  ReportScopeDto,
} from '@cogeto/shared';
import {
  DRIZZLE,
  UserContextService,
  withTransactionalEnqueue,
  writeAudit,
} from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { canonicalize, MemoryObjectStore } from '../memory/index';
import { ImportService } from '../imports/index';
import { ProjectService } from '../projects/index';
import { ReportStore, toReportDto } from './report.store';
import { REPORT_GENERATE_JOB_TYPE } from './report-jobs';
import { REPORT_OPTIONS } from './report.options';
import type { ReportOptions } from './report.options';

/**
 * The findings-report surface (V2.3 item 6.2) — trigger a findings run, poll
 * its progress, list past runs, and hand back a short-lived signed download
 * URL per format. Assembly, rendering and signing are a worker job
 * (spec §15.4); this service only creates the run (transactionally enqueuing
 * the job) and reads owner-scoped status.
 */
@Injectable()
export class ReportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly store: ReportStore,
    private readonly objects: MemoryObjectStore,
    private readonly userContext: UserContextService,
    private readonly imports: ImportService,
    @Inject(REPORT_OPTIONS) private readonly options: ReportOptions,
    /** Projects (V2.5 item 8.3): validates a project scope before the worker
     * could only fail it slowly. Optional so a bare harness is unchanged. */
    @Optional() private readonly projects?: ProjectService,
  ) {}

  /**
   * Trigger a findings run. At most one in-flight run per user: generation
   * walks the whole scope, so queueing a second concurrently would only
   * contend with the first for the same reads. The check runs INSIDE the
   * insert transaction under a per-user advisory lock (the single-flight
   * shape), so two simultaneous triggers cannot both pass it; a same-scope
   * duplicate returns the in-flight run, a different scope is refused
   * honestly rather than silently answered with the wrong run.
   */
  async trigger(principal: Principal, scope: ReportScopeDto): Promise<FindingsReportDto> {
    await this.validateScope(principal, scope);

    // The report is Cogeto-initiated copy, so its language follows the anchor
    // (the user's preferred language), never the request's Accept-Language.
    const locale = await this.userContext.preferredLanguageFor(principal.userId);

    const row = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${'cogeto:report-trigger:' + principal.userId}, 0))`,
      );
      const existing = await this.store.unfinishedForOwner(tx, principal.userId, new Date());
      if (existing) {
        if (existing.scopeKey === canonicalize(scope)) return existing;
        throw new ConflictException(
          'a report over a different scope is already being generated; wait for it to finish',
        );
      }
      const created = await this.store.createInTx(
        tx,
        principal.userId,
        principal.orgId || undefined,
        scope,
        canonicalize(scope),
        locale,
      );
      await withTransactionalEnqueue(
        tx,
        {
          type: 'report.requested',
          payload: { report_id: created.id, owner_id: principal.userId },
        },
        {
          type: REPORT_GENERATE_JOB_TYPE,
          payload: { source_type: 'findings_report', source_id: created.id },
        },
      );
      // The run is the first step of a signed egress of corpus content, so it
      // starts its audit trail here. Structural metadata only: the scope kind,
      // never the scope's contents.
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'report.requested',
        entityType: 'findings_report',
        entityId: created.id,
        detail: { scopeKind: scope.kind },
        orgId: principal.orgId,
        ownerId: principal.userId,
      });
      return created;
    });
    return toReportDto(row);
  }

  async list(principal: Principal): Promise<FindingsReportDto[]> {
    return (await this.store.listForOwner(principal.userId)).map(toReportDto);
  }

  async get(principal: Principal, id: string): Promise<FindingsReportDto> {
    const row = await this.store.getForOwner(principal.userId, id);
    if (!row) throw new NotFoundException(`report ${id} not found`);
    return toReportDto(row);
  }

  /** A short-lived signed download URL — owner-gated, only for a ready run. */
  async download(
    principal: Principal,
    id: string,
    format: ReportDownloadFormat,
  ): Promise<ReportDownloadDto> {
    const row = await this.store.getForOwner(principal.userId, id);
    if (!row) throw new NotFoundException(`report ${id} not found`);
    // A report expired by a source deletion must never mint another URL: its
    // bytes are erased by the same receipt that erased the source (the
    // passport SEC-8 rule, applied to the second content-bearing artifact).
    if (row.status === 'expired') {
      throw new BadRequestException(
        `report ${id} is no longer available: it was expired because a source it may have ` +
          `quoted was deleted, or its retention window passed. Generate a new report.`,
      );
    }
    const objectKey = format === 'pdf' ? row.pdfObjectKey : row.jsonObjectKey;
    if (row.status !== 'ready' || !objectKey) {
      throw new BadRequestException(`report ${id} is not ready to download`);
    }
    const dto = toReportDto(row);
    const ttl = this.options.downloadUrlTtlSeconds;
    const url = this.objects.presignGetUrl(objectKey, ttl, {
      filename: format === 'pdf' ? dto.pdfFilename : dto.jsonFilename,
      contentType: format === 'pdf' ? 'application/pdf' : 'application/json',
    });
    // The egress itself is the event worth recording: a presigned URL is the
    // moment the report's quoted content becomes reachable outside the box.
    await writeAudit(this.db, {
      actor: `user:${principal.userId}`,
      action: 'report.downloaded',
      entityType: 'findings_report',
      entityId: id,
      detail: {
        format,
        ttlSeconds: ttl,
        sizeBytes: (format === 'pdf' ? row.pdfSizeBytes : row.jsonSizeBytes) ?? null,
      },
      orgId: principal.orgId,
      ownerId: principal.userId,
    });
    return { url, expiresInSeconds: ttl };
  }

  /** Fail fast on a scope the worker could only fail slowly on. */
  private async validateScope(principal: Principal, scope: ReportScopeDto): Promise<void> {
    if (scope.kind === 'import') {
      // Throws NotFound for a foreign or unknown run — same signal as reads.
      await this.imports.get(principal, scope.importRunId);
      return;
    }
    if (scope.kind === 'project') {
      // Throws NotFound for a foreign or unknown project — the same signal
      // every owner-gated read gives, so scope validation cannot become a
      // probe for other users' projects.
      if (!this.projects) {
        throw new BadRequestException('projects are not available on this instance');
      }
      await this.projects.get(principal, scope.projectId);
      return;
    }
    if (scope.kind === 'sources') {
      if (scope.refs.length === 0) {
        throw new BadRequestException('a sources scope needs at least one source');
      }
      if (scope.refs.length > 200) {
        throw new BadRequestException('a sources scope is capped at 200 sources');
      }
      return;
    }
    if (scope.kind === 'date_range') {
      if (new Date(scope.from).getTime() > new Date(scope.to).getTime()) {
        throw new BadRequestException('date range: from is after to');
      }
    }
  }
}
