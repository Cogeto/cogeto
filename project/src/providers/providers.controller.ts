import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { MODEL_TIERS, PROVIDER_TYPES } from '@cogeto/shared';
import type {
  ModelConfigurationDto,
  ProviderDto,
  ProviderModelsDto,
  ProviderProbeDto,
} from '@cogeto/shared';
import { AdminGuard, BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { parseOrBadRequest } from '../infrastructure/index';
import { ProviderConfigService } from './provider-config.service';

/**
 * /api/admin/providers and /api/admin/model-configuration (V2.4 item 7.1).
 *
 * Admin-only, both surfaces: which models decide what gets remembered, and
 * which endpoints a customer's content is sent to, are instance decisions.
 * `AdminGuard` runs after the app-wide bearer guard, so a member without the
 * configured admin role gets 403 rather than a page they cannot use.
 *
 * **No response from any route here contains an API key.** The DTOs carry
 * `hasApiKey` and nothing else about it; the service assembles them from rows
 * that never selected the column.
 */

const createSchema = z.object({
  label: z.string().min(1).max(120),
  type: z.enum(PROVIDER_TYPES),
  baseUrl: z.string().max(2000).optional(),
  apiKey: z.string().min(1).max(4000).optional(),
});

const updateSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  baseUrl: z.string().max(2000).optional(),
  // `null` clears the stored key; omitted leaves it exactly as it was, which is
  // what makes "replace the key" and "rename the provider" separate actions.
  apiKey: z.string().min(1).max(4000).nullable().optional(),
});

const assignSchema = z.object({
  providerId: z.uuid().nullable(),
  model: z.string().min(1).max(200).nullable(),
});

const answerOptionSchema = z.object({
  providerId: z.uuid(),
  model: z.string().min(1).max(200),
  label: z.string().min(1).max(120),
});

const tierSchema = z.enum(MODEL_TIERS);

@Controller('admin')
@UseGuards(BearerAuthGuard, AdminGuard)
export class ProvidersController {
  constructor(private readonly providers: ProviderConfigService) {}

  @Get('providers')
  list(): Promise<ProviderDto[]> {
    return this.providers.listProviders();
  }

  @Post('providers')
  async create(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<ProviderDto> {
    const parsed = parseOrBadRequest(createSchema, body);
    const created = await this.providers.createProvider(request.principal, parsed);
    // Probe on save, so the outcome is reported immediately and specifically
    // rather than discovered on the first extraction that fails.
    await this.providers.probeProvider(created.id);
    return (await this.providers.listProviders()).find((row) => row.id === created.id) ?? created;
  }

  @Patch('providers/:id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProviderDto> {
    const parsed = parseOrBadRequest(updateSchema, body);
    const updated = await this.providers.updateProvider(request.principal, id, parsed);
    await this.providers.probeProvider(id);
    return (await this.providers.listProviders()).find((row) => row.id === id) ?? updated;
  }

  @Delete('providers/:id')
  async remove(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    await this.providers.deleteProvider(request.principal, id);
  }

  @Post('providers/:id/probe')
  probe(@Param('id') id: string): Promise<ProviderProbeDto> {
    return this.providers.probeProvider(id);
  }

  @Get('providers/:id/models')
  models(@Param('id') id: string): Promise<ProviderModelsDto> {
    return this.providers.listModels(id);
  }

  @Get('model-configuration')
  configuration(): Promise<ModelConfigurationDto> {
    return this.providers.configuration();
  }

  @Put('model-configuration/:tier')
  assign(
    @Req() request: AuthenticatedRequest,
    @Param('tier') tier: string,
    @Body() body: unknown,
  ): Promise<ModelConfigurationDto> {
    return this.providers.assignTier(
      request.principal,
      parseOrBadRequest(tierSchema, tier),
      parseOrBadRequest(assignSchema, body),
    );
  }

  @Post('model-configuration/answer-options')
  addAnswerOption(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ModelConfigurationDto> {
    return this.providers.addAnswerOption(
      request.principal,
      parseOrBadRequest(answerOptionSchema, body),
    );
  }

  @Delete('model-configuration/answer-options/:id')
  removeAnswerOption(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ModelConfigurationDto> {
    return this.providers.removeAnswerOption(request.principal, id);
  }
}
