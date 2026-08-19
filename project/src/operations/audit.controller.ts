import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { AuditEntryDto, AuditPage } from '@cogeto/shared';
import { DRIZZLE, readAuditPage, parseOrBadRequest } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { AdminGuard, BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';

const querySchema = z.object({
  actor: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  entityType: z.string().min(1).optional(),
  /** Only entries stamped with this space (docs/features/spaces.md): the
   * attribute filter the record's section 4 promises the administrator. */
  spaceId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).prefault(50),
  offset: z.coerce.number().int().min(0).prefault(0),
});

/**
 * /api/audit — the read-only audit trail (/spec §11.1; closes the
 * write-only-audit gap, audit finding 2.4). Reverse-chronological, filterable,
 * paginated. Read-only forever: this controller exposes GET only, and the
 * table's append-only trigger (migration 0001) enforces immutability below the
 * API.
 *
 * **ADMINISTRATIVE ONLY (issue #633).** It used to carry `BearerAuthGuard`
 * alone, so every authenticated member could read the whole organisation's
 * trail. `detail_json` was owner-gated, but the ACTIONS were not: actor,
 * action, entity type and entity id together let any member enumerate who
 * uploaded, deleted, exported or captured what, by identifier, across
 * everyone's private material. That is activity metadata about colleagues,
 * and "single tenant, private by default" primes the opposite expectation.
 * `AdminGuard` now runs after the global bearer guard, exactly as it does on
 * the queue, provider and model surfaces; the rail hides the section for a
 * non-admin the same way it hides System.
 *
 * Both gates below the role stay as they were and are not made redundant by
 * it: the org gate (spec §4.2) still means a caller only ever sees their own
 * organisation's entries plus system/global ones, and the per-row owner gate
 * still withholds `detail_json` from an administrator who does not own the
 * artifact. An administrator can see THAT something happened to someone
 * else's material, which is the operator's job; they do not thereby acquire
 * its detail.
 *
 * The query itself is `readAuditPage` on infrastructure's public interface,
 * which owns `audit_log`. What stays here is what needs the Principal: the org
 * argument, and the per-row owner gate on `detail_json`.
 */
@Controller('audit')
@UseGuards(BearerAuthGuard, AdminGuard)
export class AuditController {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown): Promise<AuditPage> {
    const parsed = parseOrBadRequest(querySchema, query ?? {});
    const q = parsed;

    const { rows, total } = await readAuditPage(this.db, {
      // The org gate is the reader's required argument (spec §4.2): a caller
      // sees only their org's entries plus system/global (null-org) ones.
      orgId: request.principal.orgId,
      ...(q.actor ? { actor: q.actor } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.spaceId ? { spaceId: q.spaceId } : {}),
      ...(q.from ? { from: new Date(q.from) } : {}),
      ...(q.to ? { to: new Date(q.to) } : {}),
      limit: q.limit,
      offset: q.offset,
    });

    const items: AuditEntryDto[] = rows.map((row) => {
      // Detail gate: the ENTRY is org-visible
      // (who did what to which id — the org-wide trail), but detail_json is
      // returned only to the stamped owner. Ownerless rows are system entries
      // whose detail is structural metadata by the writer contract. Detail is
      // structural-only everywhere since 0025; this gate is defense in depth
      // for anything a future writer gets wrong.
      const isOwner = row.ownerId === null || row.ownerId === request.principal.userId;
      return {
        id: row.id,
        actor: row.actor,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        detail: isOwner ? row.detail : null,
        ...(isOwner ? {} : { detailWithheld: true as const }),
        createdAt: row.createdAt.toISOString(),
      };
    });
    return { items, total };
  }
}
