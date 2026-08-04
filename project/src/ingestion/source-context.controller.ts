import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { sourceTypeDescriptor } from '@cogeto/shared';
import type { SourceContextDto } from '@cogeto/shared';
import { BadRequestException } from '@nestjs/common';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { parseOrBadRequest } from '../infrastructure/index';
import { SourceContextStore } from './persistence/source-context.store';
import type { SourceContextRow } from './persistence/tables';

/**
 * /api/source-context — the anchoring context's read and edit surface
 * (V2.1 item 4.2, spec 1.5.3). Owned by ingestion, the module that owns the
 * table; rendered on the source drawer beside the read report.
 *
 * Reads and writes are owner-gated: the context belongs to the source's owner,
 * and a foreign source reads as absent rather than confirmed. Editing marks
 * the row user-edited, which the anchor stage treats as authoritative; the
 * re-anchor itself is the existing reprocess action on the source.
 */

const setContextSchema = z.object({
  subjects: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        confident: z.boolean().optional(),
      }),
    )
    .max(12),
  documentClass: z.string().min(1).max(60).nullable(),
  revision: z.string().min(1).max(60).nullable(),
});

@Controller('source-context')
@UseGuards(BearerAuthGuard)
export class SourceContextController {
  constructor(private readonly store: SourceContextStore) {}

  @Get(':sourceType/:sourceId')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('sourceType') sourceType: string,
    @Param('sourceId') sourceId: string,
  ): Promise<SourceContextDto> {
    assertRegistered(sourceType);
    const row = await this.store.getForOwner(request.principal, sourceType, sourceId);
    if (!row) throw new NotFoundException('no source context for this source');
    return toDto(row);
  }

  @Put(':sourceType/:sourceId')
  async set(
    @Req() request: AuthenticatedRequest,
    @Param('sourceType') sourceType: string,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
  ): Promise<SourceContextDto> {
    assertRegistered(sourceType);
    const patch = parseOrBadRequest(setContextSchema, body);
    const sanitize = (value: string): string => value.replace(/\s+/g, ' ').trim();
    const row = await this.store.setForOwner(request.principal, sourceType, sourceId, {
      // A subject the user typed is confident unless they said otherwise.
      subjects: patch.subjects
        .map((subject) => ({ name: sanitize(subject.name), confident: subject.confident ?? true }))
        .filter((subject) => subject.name.length > 0),
      documentClass: patch.documentClass ? sanitize(patch.documentClass) : null,
      documentClassConfident: patch.documentClass !== null,
      revision: patch.revision ? sanitize(patch.revision) : null,
      revisionConfident: patch.revision !== null,
    });
    return toDto(row);
  }
}

function assertRegistered(sourceType: string): void {
  const descriptor = sourceTypeDescriptor(sourceType);
  if (!descriptor || descriptor.defunct || !descriptor.extraction) {
    throw new BadRequestException(`'${sourceType}' is not an extraction-capable source type`);
  }
}

function toDto(row: SourceContextRow): SourceContextDto {
  return {
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    subjects: row.subjects,
    documentClass: row.documentClass,
    documentClassConfident: row.documentClassConfident,
    revision: row.revision,
    revisionConfident: row.revisionConfident,
    editedByUser: row.editedByUser,
    promptVersion: row.promptVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}
