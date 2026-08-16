import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parseOrBadRequest, userError } from '../infrastructure/index';
import { AdminGuard, BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { OwnerErasureService } from './owner-erasure.service';
import type { OwnerErasurePlan } from './owner-erasure.service';

/**
 * The confirmation. It is not a boolean: an administrator must TYPE the
 * subject's own identifier back, so an irreversible act over someone else's
 * material cannot be a mis-click or a copied curl with the wrong id in it.
 * The same shape the operator script uses for its typed confirmations.
 */
const eraseSchema = z.object({
  confirmUserId: z.string().min(1),
});

/** The plan as the API returns it: counts and a bounded sample, never a dump. */
interface ErasurePlanDto {
  subjectUserId: string;
  toEraseCount: number;
  retainedSharedCount: number;
  byType: Record<string, number>;
  /** What check 2 can still retain, stated rather than promised as a number. */
  note: string;
}

const PLAN_NOTE =
  'Shared material is never erased. A private source is also retained when any fact ' +
  'derived from it is shared, which this plan cannot count without enumerating every ' +
  'derived memory; the completed run reports those retentions with their reason.';

function toDto(plan: OwnerErasurePlan): ErasurePlanDto {
  const byType: Record<string, number> = {};
  for (const source of plan.toErase) {
    byType[source.sourceType] = (byType[source.sourceType] ?? 0) + 1;
  }
  return {
    subjectUserId: plan.subjectUserId,
    toEraseCount: plan.toErase.length,
    retainedSharedCount: plan.retainedShared.length,
    byType,
    note: PLAN_NOTE,
  };
}

/**
 * `/api/admin/erasure` — erasing a departed user's private material
 * (issue #632).
 *
 * ADMINISTRATIVE ONLY, and the guard is the enforcement: `AdminGuard` runs
 * after the global bearer guard exactly as it does on the queue, provider and
 * audit surfaces. There is no per-user variant of this route and there must
 * never be one; a user deleting their own material has the ordinary
 * source-deletion path, which is owner-gated and needs no role.
 *
 * The subject is a stored `owner_id` STRING, never a resolved principal. That
 * is the requirement rather than a shortcut: the feature exists for the state
 * where the account is deactivated or removed from the identity provider, so
 * anything here that needed the subject to be resolvable would fail exactly
 * when it is needed. The route therefore does not validate that the subject
 * exists anywhere — it validates that the administrator typed the same
 * identifier twice.
 *
 * The work runs in the worker. This route plans, audits and enqueues; it
 * returns the plan's real numbers so the administrator sees what was set in
 * motion rather than a bare acknowledgement.
 */
@Controller('admin/erasure')
@UseGuards(BearerAuthGuard, AdminGuard)
export class OwnerErasureController {
  constructor(private readonly erasure: OwnerErasureService) {}

  /** What an erasure would remove, and what it would keep. Read-only. */
  @Get(':userId')
  async preview(@Param('userId') userId: string): Promise<ErasurePlanDto> {
    return toDto(await this.erasure.plan(userId));
  }

  /** Requests the erasure. Irreversible, hence the typed confirmation. */
  @Post(':userId')
  async erase(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<ErasurePlanDto & { accepted: true }> {
    const parsed = parseOrBadRequest(eraseSchema, body);
    if (parsed.confirmUserId !== userId) {
      throw userError.badRequest(
        'erasure.confirmationMismatch',
        'the confirmation must repeat the user id being erased',
      );
    }
    // Erasing yourself through the administrative path would bypass nothing
    // (an owner may already delete their own sources) but would put a
    // misleading "on behalf of" entry in the trail and is never what someone
    // means to do. The ordinary deletion path is the one for that.
    if (userId === request.principal.userId) {
      throw userError.badRequest(
        'erasure.notYourself',
        'use the ordinary source deletion path to remove your own material',
      );
    }
    const plan = await this.erasure.request(request.principal, userId);
    return { ...toDto(plan), accepted: true };
  }
}
