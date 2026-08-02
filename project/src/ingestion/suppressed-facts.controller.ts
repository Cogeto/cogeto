import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { UNCERTAINTY_REASONS } from '@cogeto/shared';
import type {
  FactKind,
  SuppressedFactDto,
  SuppressedFactPageDto,
  SuppressedFactSummaryDto,
} from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { SuppressedFactLog } from './persistence/suppressed-fact-log';
import type { SuppressedFactQuery } from './persistence/suppressed-fact-log';
import type { SuppressedFactRow } from './persistence/tables';
import { parseOrBadRequest } from '../infrastructure/index';

/**
 * /api/suppressed-facts — the query surface over the suppressed-fact log
 * (V2.0 item 3.3).
 *
 * It exists now, ahead of its consumers, because both are already specified: the
 * V2.2 source detail view lists a source's entries and the V2.3 findings report
 * summarises them. Shipping the read shape with the write shape is what stops
 * the log from silently becoming a debug trail nobody can query.
 *
 * Gating is the store's, not this controller's: every read applies the same
 * scope + sensitive predicate memory reads apply, so an entry is exactly as
 * visible as the fact it explains.
 */

const querySchema = z.object({
  sourceType: z.string().min(1).optional(),
  sourceId: z.string().min(1).optional(),
  reason: z.enum(UNCERTAINTY_REASONS).optional(),
  /** Inclusive ISO bounds on the decision timestamp. */
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

@Controller('suppressed-facts')
@UseGuards(BearerAuthGuard)
export class SuppressedFactsController {
  constructor(private readonly log: SuppressedFactLog) {}

  /** Entries the caller may see, newest first: by source, reason, date range. */
  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<SuppressedFactPageDto> {
    const page = await this.log.list(request.principal, parseQuery(query));
    return { items: page.items.map(toDto), total: page.total };
  }

  /** The same gate and the same filters, as counts per reason. */
  @Get('summary')
  async summary(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<SuppressedFactSummaryDto> {
    return this.log.summarize(request.principal, parseQuery(query));
  }
}

function parseQuery(raw: unknown): SuppressedFactQuery {
  const parsed = parseOrBadRequest(querySchema, raw ?? {});
  const { from, to, ...rest } = parsed;
  return {
    ...rest,
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
  };
}

function toDto(row: SuppressedFactRow): SuppressedFactDto {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    factContent: row.factContent,
    factKind: row.factKind as FactKind | null,
    sourceSpan: row.sourceSpan,
    reason: row.reason,
    verificationVerdict: row.verificationVerdict,
    verificationReason: row.verificationReason,
    promptVersion: row.promptVersion,
    memoryId: row.memoryId,
    createdAt: row.createdAt.toISOString(),
  };
}
