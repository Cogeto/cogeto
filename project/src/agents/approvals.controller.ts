import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { ApprovalDto, EmailReplyDraftView } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { ApprovalService } from './approval.service';

const createSchema = z.object({
  actionType: z.string().min(1),
  payload: z.unknown(),
});
const confirmSchema = z.object({
  decision: z.enum(['approve', 'reject']),
});

/**
 * /api/approvals — the authenticated approval surface (§A.8). This is the ONLY
 * approval path: the confirm route flips server-side state (and, on approve,
 * enqueues the worker execution job) and does nothing else. A front-end dialog
 * is never sufficient; execution lives in the worker. The service owns all
 * authorization (owner org) and legality; these routes stay thin.
 */
@Controller('approvals')
@UseGuards(BearerAuthGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalService) {}

  /** Create a pending approval for a registered consequential action. */
  @Post()
  async create(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<ApprovalDto> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('body must be { actionType, payload }');
    return this.approvals.create(request.principal, parsed.data.actionType, parsed.data.payload);
  }

  /** The pending queue (owner org). */
  @Get()
  async listPending(@Req() request: AuthenticatedRequest): Promise<ApprovalDto[]> {
    return this.approvals.listPending(request.principal);
  }

  /** Executed / rejected / expired — the read-only audited trail. */
  @Get('history')
  async listHistory(@Req() request: AuthenticatedRequest): Promise<ApprovalDto[]> {
    return this.approvals.listHistory(request.principal);
  }

  @Get(':id')
  async get(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<ApprovalDto> {
    return this.approvals.get(request.principal, id);
  }

  /**
   * The finalised reply draft (Session O4 — email source): the drafted subject +
   * body, a prefilled mailto:, and a downloadable .eml, for the user to send from
   * their OWN client. Cogeto never sends. Owner-only (the body is content).
   */
  @Get(':id/email-draft')
  async emailDraft(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<EmailReplyDraftView> {
    return this.approvals.getEmailDraft(request.principal, id);
  }

  /** The confirm transition: approve | reject. State only — no effect here. */
  @Post(':id')
  async confirm(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ApprovalDto> {
    const parsed = confirmSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('body must be { decision: approve|reject }');
    return this.approvals.confirm(request.principal, id, parsed.data.decision);
  }
}
