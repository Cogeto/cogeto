import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type {
  AttentionDismissDto,
  AttentionFeedDto,
  AttentionSeenDto,
  DashboardStatsDto,
} from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { AttentionService } from './attention.service';

const dismissSchema = z.object({ key: z.string().min(1).max(200) });

/**
 * /api/attention — the in-app "what needs my attention" surface (Post-v1
 * Priority 2). A computed, Principal-gated feed plus the honest unread state.
 * The service owns all gating and composition; these routes stay thin.
 */
@Controller('attention')
@UseGuards(BearerAuthGuard)
export class AttentionController {
  constructor(private readonly attention: AttentionService) {}

  @Get()
  async feed(@Req() request: AuthenticatedRequest): Promise<AttentionFeedDto> {
    return this.attention.getFeed(request.principal);
  }

  /** Viewing the surface clears the unread indicator (not clicking each item). */
  @Post('seen')
  async seen(@Req() request: AuthenticatedRequest): Promise<AttentionSeenDto> {
    return { lastSeenAt: await this.attention.markSeen(request.principal) };
  }

  /** Per-item dismissal — digest lines only (a live count is never dismissible). */
  @Post('dismiss')
  async dismiss(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<AttentionDismissDto> {
    const parsed = dismissSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('body must be { key }');
    await this.attention.dismiss(request.principal, parsed.data.key);
    return { dismissed: true };
  }
}

/**
 * /api/dashboard/stats — cheap, gated aggregates for the redesigned home
 * screen. Counts, grouped counts, and two bounded daily series; no unbounded
 * scan on page load.
 */
@Controller('dashboard')
@UseGuards(BearerAuthGuard)
export class DashboardController {
  constructor(private readonly attention: AttentionService) {}

  @Get('stats')
  async stats(@Req() request: AuthenticatedRequest): Promise<DashboardStatsDto> {
    return this.attention.getStats(request.principal);
  }
}
