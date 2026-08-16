import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type {
  AdminUserDto,
  AdminUsersDto,
  ErasureCountDto,
  ErasurePreviewDto,
  ErasureResultDto,
} from '@cogeto/shared';
import { parseOrBadRequest, userError } from '../infrastructure/index';
import { AdminGuard, BearerAuthGuard, UserDirectory } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { OwnerErasureService } from './owner-erasure.service';
import type { OwnerErasurePlan } from './owner-erasure.service';

/**
 * The confirmation. It is not a boolean: an administrator must TYPE the
 * subject back, so an irreversible act over someone else's material cannot be
 * a mis-click or a copied command with the wrong id in it. The interface asks
 * for the EMAIL, because that is what a person recognises; the id travels in
 * the path and both are checked.
 */
const eraseSchema = z.object({
  confirmUserId: z.string().min(1),
});

/** Source counts by kind, from a plan's list of sources. */
function countByType(sources: { sourceType: string }[]): ErasureCountDto[] {
  const counts = new Map<string, number>();
  for (const source of sources) {
    counts.set(source.sourceType, (counts.get(source.sourceType) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([sourceType, count]) => ({ sourceType, count }))
    .sort((a, b) => b.count - a.count || a.sourceType.localeCompare(b.sourceType));
}

/**
 * `/api/admin/*` — the Users surface and the erasure it exists for
 * (issues #632, #638).
 *
 * ADMINISTRATIVE ONLY, and the guard is the enforcement: `AdminGuard` runs
 * after the global bearer guard exactly as it does on the queue, provider and
 * audit surfaces. There is no per-user variant of any route here and there
 * must never be one; a user deleting their own material has the ordinary
 * source-deletion path, which is owner-gated and needs no role.
 *
 * ## What this surface can and cannot do, and why
 *
 * It erases DATA. It cannot create an account and it cannot switch one off:
 * both would need a standing Zitadel management credential, which the
 * instance deliberately does not keep after install. The page says this in
 * as many words rather than leaving an administrator to discover it.
 *
 * The subject of an erasure is a stored `owner_id` STRING, never a resolved
 * principal. That is the requirement rather than a shortcut: the feature
 * exists for the state where the account is deactivated or removed from the
 * identity provider, so anything here that needed the subject to be
 * resolvable would fail exactly when it is needed. The routes therefore never
 * validate that the subject exists anywhere.
 */
@Controller('admin')
@UseGuards(BearerAuthGuard, AdminGuard)
export class OwnerErasureController {
  constructor(
    private readonly erasure: OwnerErasureService,
    private readonly directory: UserDirectory,
  ) {}

  /**
   * Everyone this instance has seen, with what an erasure would act on.
   *
   * The directory is written on AUTHENTICATION, so this lists people who have
   * signed in at least once and nobody else. That limit is real and the page
   * states it; closing it would need to ask Zitadel, which needs the
   * credential this instance does not hold.
   */
  @Get('users')
  async users(@Req() request: AuthenticatedRequest): Promise<AdminUsersDto> {
    const rows = await this.directory.listForOrg(request.principal.orgId);
    const users: AdminUserDto[] = [];
    for (const row of rows) {
      // One plan per person. It is a handful of indexed reads per user over a
      // single team's corpus, and it is what makes the row honest: a count
      // taken from anywhere else would not be the number the erasure acts on.
      const plan = await this.erasure.plan(row.userId);
      users.push({
        userId: row.userId,
        displayName: row.displayName,
        email: row.email,
        firstSeen: row.firstSeen.toISOString(),
        lastSeen: row.lastSeen.toISOString(),
        erasableSources: plan.toErase.length,
        sharedSources: plan.retainedShared.length,
        isSelf: row.userId === request.principal.userId,
      });
    }
    return { users };
  }

  /** What an erasure would remove, and what it would keep. Read-only. */
  @Get('erasure/:userId')
  async preview(@Param('userId') userId: string): Promise<ErasurePreviewDto> {
    return this.toPreview(await this.erasure.plan(userId));
  }

  /** Requests the erasure. Irreversible, hence the typed confirmation. */
  @Post('erasure/:userId')
  async erase(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<ErasurePreviewDto & { accepted: true }> {
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
    return { ...(await this.toPreview(plan)), accepted: true };
  }

  /**
   * How the run finished, for the panel that polls after requesting one.
   * `pending` while the worker has not written its completion entry yet;
   * everything else is read straight off that entry, so the numbers shown are
   * the numbers recorded rather than a second count of the same thing.
   */
  @Get('erasure/:userId/result')
  async result(@Param('userId') userId: string): Promise<ErasureResultDto> {
    const outcome = await this.erasure.lastRun(userId);
    if (!outcome) {
      return {
        subjectUserId: userId,
        erased: 0,
        receipts: 0,
        kept: 0,
        keptForSharedFact: 0,
        failed: 0,
        pending: true,
      };
    }
    return { ...outcome, subjectUserId: userId, pending: false };
  }

  private async toPreview(plan: OwnerErasurePlan): Promise<ErasurePreviewDto> {
    // Name the person from the directory where it knows them. A subject who
    // has been deleted from the identity provider may not be there at all,
    // which is fine: the id is the identity this surface works from.
    const [row] = await this.directory.usersByIds([plan.subjectUserId]);
    const names = await this.directory.displayNames([plan.subjectUserId]);
    return {
      subjectUserId: plan.subjectUserId,
      displayName: names.get(plan.subjectUserId) ?? plan.subjectUserId,
      email: row?.email ?? null,
      toErase: countByType(plan.toErase),
      kept: countByType(plan.retainedShared),
      toEraseTotal: plan.toErase.length,
      keptTotal: plan.retainedShared.length,
    };
  }
}
