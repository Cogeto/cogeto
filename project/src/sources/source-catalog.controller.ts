import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { SourceCatalogPageDto, SourceInspectionDto } from '@cogeto/shared';
import { SOURCE_BADGE_FILTERS, SOURCE_TYPE_KEYS } from '@cogeto/shared';
import { parseOrBadRequest } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { SourceCatalogService } from './source-catalog.service';
import type { CatalogQuery } from './source-catalog.service';

const listSchema = z.object({
  type: z.enum(SOURCE_TYPE_KEYS).optional(),
  badge: z.enum(SOURCE_BADGE_FILTERS).optional(),
  q: z.string().max(200).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  cursor: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * /api/source-catalog — the Sources surface's level one and two (V2.2 item
 * 5.2). Deletion stays where it was (/api/sources, the saga's controller);
 * this surface only reads.
 */
@Controller('source-catalog')
@UseGuards(BearerAuthGuard)
export class SourceCatalogController {
  constructor(private readonly catalog: SourceCatalogService) {}

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<SourceCatalogPageDto> {
    const parsed = parseOrBadRequest(listSchema, query ?? {});
    const catalogQuery: CatalogQuery = {
      type: parsed.type as CatalogQuery['type'],
      badge: parsed.badge,
      q: parsed.q,
      order: parsed.order,
      cursor: parsed.cursor ? new Date(parsed.cursor) : undefined,
      limit: parsed.limit,
    };
    return this.catalog.list(request.principal, catalogQuery);
  }

  @Get(':sourceType/:sourceId')
  async inspect(
    @Req() request: AuthenticatedRequest,
    @Param('sourceType') sourceType: string,
    @Param('sourceId') sourceId: string,
  ): Promise<SourceInspectionDto> {
    return this.catalog.inspect(request.principal, sourceType, sourceId);
  }
}
