import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { MemoryListItem } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { MemoryStore } from './memory.store';
import type { MemoryRow } from './persistence/tables';

function toListItem(row: MemoryRow): MemoryListItem {
  return {
    id: row.id,
    content: row.content,
    status: row.status,
    scope: row.scope,
    sensitive: row.sensitive,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    validFrom: row.validFrom?.toISOString() ?? null,
    validUntil: row.validUntil?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * GET /api/memories — the Memories (preview) list (S2-A). A placeholder the
 * S3 dashboard replaces; reads go through MemoryStore, so the scope and
 * sensitive gates apply. `includeSensitive=true` is the explicit per-query
 * opt-in of decision 0003 ruling 3 (owner-only even then).
 */
@Controller('memories')
@UseGuards(BearerAuthGuard)
export class MemoriesController {
  constructor(private readonly store: MemoryStore) {}

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('includeSensitive') includeSensitive?: string,
  ): Promise<MemoryListItem[]> {
    const rows = await this.store.listForPrincipal(request.principal, {
      includeSensitive: includeSensitive === 'true',
      limit: 50,
    });
    return rows.map(toListItem);
  }
}
