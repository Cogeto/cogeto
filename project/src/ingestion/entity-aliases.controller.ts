import {
  Controller,
  Body,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { resolveSpaceId } from '@cogeto/shared';
import type { EntityAliasDto } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { parseOrBadRequest, userError } from '../infrastructure/index';
import { foldEntityName } from './domain/entity-match';
import { EntityAliasStore } from './persistence/entity-alias.store';
import type { EntityAliasRow } from './persistence/tables';

/**
 * /api/reconcile-aliases — the owner's entity-alias set (V2.3 item 6.1,
 * issue A): the recorded equivalences behind alias-aware contradiction
 * pairing, cross-language names above all. Owned by ingestion, the module
 * whose candidate rules consume them; rendered on the Settings page, the
 * extraction-gate precedent. Owner-scoped in every query; adding a pair the
 * folding rules already unify is refused with the reason, so the list stays
 * a record of what the DATA adds, not what the code already knew.
 */

const addAliasSchema = z.object({
  canonical: z.string().trim().min(1).max(200),
  alias: z.string().trim().min(1).max(200),
});

const toDto = (row: EntityAliasRow): EntityAliasDto => ({
  id: row.id,
  canonical: row.canonical,
  alias: row.alias,
  createdAt: row.createdAt.toISOString(),
});

@Controller('reconcile-aliases')
@UseGuards(BearerAuthGuard)
export class EntityAliasesController {
  constructor(private readonly store: EntityAliasStore) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<EntityAliasDto[]> {
    const rows = await this.store.listForOwner(
      request.principal.userId,
      resolveSpaceId(request.principal),
    );
    return rows.map(toDto);
  }

  @Post()
  async add(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<EntityAliasDto> {
    const input = parseOrBadRequest(addAliasSchema, body);
    if (foldEntityName(input.canonical) === foldEntityName(input.alias)) {
      throw userError.badRequest(
        'alias.notNeeded',
        'these names already match after normalization; no alias is needed',
      );
    }
    const row = await this.store.add(
      request.principal.userId,
      input.canonical,
      input.alias,
      resolveSpaceId(request.principal),
    );
    if (!row) {
      throw userError.badRequest('alias.duplicate', 'this alias pair is already recorded');
    }
    return toDto(row);
  }

  @Delete(':id')
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ removed: boolean }> {
    const removed = await this.store.remove(request.principal.userId, id);
    if (!removed) throw userError.notFound('alias.notFound', 'alias {{id}} not found', { id });
    return { removed };
  }
}
