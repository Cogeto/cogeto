import { Controller, Delete, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { DeletionPreviewDto, DeletionRequestedDto } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { DeletionSaga } from './deletion-saga';

/**
 * /api/sources — source-level true deletion (§A.7, §B.1). DELETE starts the
 * saga: the response's receiptId is the handle to the pending receipt that
 * the worker confirms once Qdrant and MinIO acknowledged. The saga owns all
 * authorization (owner-only) and validation; these routes stay thin.
 *
 * :id is a plain string, not a UUID — file sources are keyed by object key
 * (path segments URL-encoded by the caller).
 */
@Controller('sources')
@UseGuards(BearerAuthGuard)
export class SourcesController {
  constructor(private readonly saga: DeletionSaga) {}

  /** What deletion would remove — the confirm dialog's exact numbers. */
  @Get(':type/:id/impact')
  async impact(
    @Req() request: AuthenticatedRequest,
    @Param('type') type: string,
    @Param('id') id: string,
  ): Promise<DeletionPreviewDto> {
    return this.saga.previewSourceDeletion(request.principal, type, id);
  }

  @Delete(':type/:id')
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('type') type: string,
    @Param('id') id: string,
  ): Promise<DeletionRequestedDto> {
    const { receiptId } = await this.saga.requestSourceDeletion(request.principal, type, id);
    return { receiptId };
  }
}
