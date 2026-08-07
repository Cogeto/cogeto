import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { ContradictionDto, MemoryRelationDto } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { MemoryReconciliation } from './reconciliation';
import type { ContradictionResolveAction } from './reconciliation';
import { toListItem } from './list-item';
import { parseOrBadRequest } from '../infrastructure/index';

/** Zod at the boundary: the three resolutions. */
const contentSchema = z
  .string()
  .max(4_000, 'memory content is too long (max 4000 characters)')
  .refine((value) => value.trim().length > 0, 'memory content must not be blank');

const resolveSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm_a') }),
  z.object({ action: z.literal('confirm_b') }),
  z.object({ action: z.literal('correct'), aContent: contentSchema, bContent: contentSchema }),
  z.object({ action: z.literal('dismiss') }),
]);

/**
 * The contradicted queue (Review's second tab): open contradictions
 * where both facts belong to the caller, and the owner's resolution actions.
 * All state changes and audits happen inside MemoryReconciliation.
 */
@Controller('relations')
@UseGuards(BearerAuthGuard)
export class RelationsController {
  constructor(private readonly reconciliation: MemoryReconciliation) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<ContradictionDto[]> {
    const open = await this.reconciliation.listOpenContradictions(request.principal);
    return open.map(({ relation, a, b }) => ({
      id: relation.id,
      detectedAt: relation.detectedAt.toISOString(),
      reason: relation.reason ?? null,
      detectedBy: relation.detectedBy ?? null,
      a: toListItem(a),
      b: toListItem(b),
    }));
  }

  /**
   * Every contradiction relation ONE memory is party to, resolved included,
   * with the counterpart riding along (V2.2 item 5.2, the fact detail view).
   */
  @Get('for-memory/:memoryId')
  async forMemory(
    @Req() request: AuthenticatedRequest,
    @Param('memoryId', ParseUUIDPipe) memoryId: string,
  ): Promise<MemoryRelationDto[]> {
    const relations = await this.reconciliation.relationsForMemory(request.principal, memoryId);
    // One events read for the whole answer: the finding's history rides along
    // (V2.3 item 6.1), owner-gated inside eventsForRelations itself.
    const events = await this.reconciliation.eventsForRelations(
      request.principal,
      relations.map(({ relation }) => relation.id),
    );
    return relations.map(({ relation, other }) => ({
      relationId: relation.id,
      detectedAt: relation.detectedAt.toISOString(),
      resolvedAt: relation.resolvedAt?.toISOString() ?? null,
      resolution: relation.resolution,
      reason: relation.reason ?? null,
      detectedBy: relation.detectedBy ?? null,
      events: (events.get(relation.id) ?? []).map((event) => ({
        event: event.event,
        detail: (event.detailJson as Record<string, unknown> | null) ?? null,
        createdAt: event.createdAt.toISOString(),
      })),
      other: toListItem(other),
    }));
  }

  @Post(':id/resolve')
  async resolve(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<{ resolved: boolean }> {
    const parsed = parseOrBadRequest(resolveSchema, body);
    const data = parsed;
    const action: ContradictionResolveAction =
      data.action === 'confirm_a'
        ? { type: 'confirm', winner: 'a' }
        : data.action === 'confirm_b'
          ? { type: 'confirm', winner: 'b' }
          : data.action === 'correct'
            ? { type: 'correct', aContent: data.aContent.trim(), bContent: data.bContent.trim() }
            : { type: 'dismiss' };
    await this.reconciliation.resolveContradiction(request.principal, id, action);
    return { resolved: true };
  }
}
