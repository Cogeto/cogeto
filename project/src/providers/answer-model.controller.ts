import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { UserAnswerModelDto } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { parseOrBadRequest } from '../infrastructure/index';
import { ProviderConfigService } from './provider-config.service';

/**
 * /api/settings/answer-model (V2.4 item 7.1): the ONE model choice that is a
 * user's own.
 *
 * The answer tier is the model that phrases what a user reads, so which one
 * does it is a preference. Pipeline, embeddings and vision are not: they decide
 * what gets remembered, how it is indexed and what gets read off a page, and
 * those are instance decisions with an eval gate behind them. The admin
 * controls the set this endpoint can choose from; choosing outside it is a 400,
 * not a silent fallback.
 */

const updateSchema = z.object({ optionId: z.uuid().nullable() });

@Controller('settings/answer-model')
@UseGuards(BearerAuthGuard)
export class AnswerModelController {
  constructor(private readonly providers: ProviderConfigService) {}

  @Get()
  get(@Req() request: AuthenticatedRequest): Promise<UserAnswerModelDto> {
    return this.providers.answerModelFor(request.principal);
  }

  @Put()
  update(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<UserAnswerModelDto> {
    const parsed = parseOrBadRequest(updateSchema, body);
    return this.providers.setAnswerModelFor(request.principal, parsed.optionId);
  }
}
