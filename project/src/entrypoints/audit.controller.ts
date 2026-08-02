import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { and, count, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { AuditEntryDto, AuditPage } from '@cogeto/shared';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
// RECORDED EXCEPTION B8 (docs/module-boundary-contract.md): this controller
// reads `audit_log`, which `infrastructure` owns. It is not a laundered barrel
// import any more — it names the private table path, is allowlisted by name in
// .dependency-cruiser.cjs, and moves behind infrastructure's interface in
// V2.0 item 3.6 part 2, when the accidental context in entrypoints/ dissolves.
import { auditLog } from '../infrastructure/persistence/tables';
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

    const clauses: SQL[] = [
      // The org gate — never another org's entries; null-org = system/global.
      or(eq(auditLog.orgId, request.principal.orgId), isNull(auditLog.orgId))!,
    ];
    // escape LIKE metacharacters so a user-supplied `%`/`_` is matched
    // literally (not as a wildcard) — no match-everything, no slow leading-wildcard
    // patterns. The bound ESCAPE clause makes `\` the escape character.
    if (q.actor)
      clauses.push(sql`${auditLog.actor} ILIKE ${`%${escapeLike(q.actor)}%`} ESCAPE '\\'`);
    if (q.action)
      clauses.push(sql`${auditLog.action} ILIKE ${`%${escapeLike(q.action)}%`} ESCAPE '\\'`);
    if (q.entityType) clauses.push(eq(auditLog.entityType, q.entityType));
    if (q.from) clauses.push(gte(auditLog.createdAt, new Date(q.from)));
    if (q.to) clauses.push(lt(auditLog.createdAt, new Date(q.to)));
    const where = and(...clauses);

    const [rows, totalRows] = await Promise.all([
      this.db
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.createdAt))
        .limit(q.limit)
        .offset(q.offset),
      this.db.select({ n: count() }).from(auditLog).where(where),
    ]);

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
        detail: isOwner ? ((row.detailJson as Record<string, unknown> | null) ?? null) : null,
        ...(isOwner ? {} : { detailWithheld: true as const }),
        createdAt: row.createdAt.toISOString(),
      };
    });
    return { items, total: Number(totalRows[0]?.n ?? 0) };
  }
}

/** Escape LIKE/ILIKE metacharacters so user input matches literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
