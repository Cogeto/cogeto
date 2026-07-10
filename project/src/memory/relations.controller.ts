import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { ContradictionDto } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { MemoryReconciliation } from './reconciliation';
import type { ContradictionResolveAction } from './reconciliation';
import { toListItem } from './list-item';

/** Zod at the boundary: the three resolutions (decision 0010 ruling 3). */
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
 * The contradicted queue (Review's second tab, F2-A): open contradictions
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
      a: toListItem(a),
      b: toListItem(b),
    }));
  }

  @Post(':id/resolve')
  async resolve(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<{ resolved: boolean }> {
    const parsed = resolveSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const data = parsed.data;
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
