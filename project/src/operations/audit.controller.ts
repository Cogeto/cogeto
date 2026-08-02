import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { AuditEntryDto, AuditPage } from '@cogeto/shared';
import { DRIZZLE, readAuditPage } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';

const querySchema = z.object({
  actor: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  entityType: z.string().min(1).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).prefault(50),
  offset: z.coerce.number().int().min(0).prefault(0),
});

/**
 * /api/audit — the read-only audit trail (/spec §11.1; closes the
 * write-only-audit gap, audit finding 2.4). Reverse-chronological, filterable,
 * paginated. Org-scoped (spec §4.2): a caller sees only their org's entries plus
 * system/global (null-org) ones — never another org's. Read-only forever: this
 * controller exposes GET only, and the table's append-only trigger (migration
 * 0001) enforces immutability below the API.
 *
 * The query itself is `readAuditPage` on infrastructure's public interface,
 * which owns `audit_log`. What stays here is what needs the Principal: the org
 * argument, and the per-row owner gate on `detail_json`.
 */
@Controller('audit')
@UseGuards(BearerAuthGuard)
export class AuditController {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown): Promise<AuditPage> {
    const parsed = querySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const q = parsed.data;

    const { rows, total } = await readAuditPage(this.db, {
      // The org gate is the reader's required argument (spec §4.2): a caller
      // sees only their org's entries plus system/global (null-org) ones.
      orgId: request.principal.orgId,
      ...(q.actor ? { actor: q.actor } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
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
