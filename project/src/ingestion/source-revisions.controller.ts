import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { SourceRevisionDto } from '@cogeto/shared';
import { parseOrBadRequest } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { SourceRevisionStore } from './persistence/source-revision.store';
import type { SourceRevisionRow } from './persistence/tables';

const refSchema = z.object({
  sourceType: z.string().min(1).max(40),
  sourceId: z.string().min(1).max(500),
});
const linkSchema = z.object({ successor: refSchema, predecessor: refSchema });

/**
 * /api/source-revisions — the revision link's owner surface (V2.2 item 5.3):
 * what is linked or proposed for a source, and the three manual controls.
 * Detection lives in the import coordinator; this only reads and decides.
 */
@Controller('source-revisions')
@UseGuards(BearerAuthGuard)
export class SourceRevisionsController {
  constructor(private readonly revisions: SourceRevisionStore) {}

  @Get(':sourceType/:sourceId')
  async forSource(
    @Req() request: AuthenticatedRequest,
    @Param('sourceType') sourceType: string,
    @Param('sourceId') sourceId: string,
  ): Promise<SourceRevisionDto[]> {
    const rows = await this.revisions.forSource(request.principal, { sourceType, sourceId });
    return rows.map(toDto);
  }

  @Post(':id/confirm')
  async confirm(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SourceRevisionDto> {
    return toDto(await this.revisions.decide(request.principal, id, 'confirmed'));
  }

  @Post(':id/reject')
  async reject(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SourceRevisionDto> {
    return toDto(await this.revisions.decide(request.principal, id, 'rejected'));
  }

  @Post('link')
  async link(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<SourceRevisionDto> {
    const parsed = parseOrBadRequest(linkSchema, body);
    return toDto(
      await this.revisions.linkManually(request.principal, parsed.successor, parsed.predecessor),
    );
  }
}

function toDto(row: SourceRevisionRow): SourceRevisionDto {
  return {
    id: row.id,
    successorType: row.successorType,
    successorId: row.successorId,
    predecessorType: row.predecessorType,
    predecessorId: row.predecessorId,
    status: row.status,
    basis: row.basisJson ?? null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}
