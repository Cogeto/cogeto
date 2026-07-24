import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Optional,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { ContextSuggestionsDto, UserContextDto } from '@cogeto/shared';
import { SUPPORTED_LANGUAGES } from '@cogeto/shared';
import {
  DEFAULT_INSTANCE_TIMEZONE,
  INSTANCE_TIMEZONE,
  UserContextService,
} from '../infrastructure/index';
import type { UserContextRecord } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { ContextSuggestionsService } from './context-suggestions.service';

/** A settable IANA zone: whatever Intl accepts on this runtime. */
function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Free-text profile fields: trimmed, bounded, empty string clears to null. */
const profileField = (max: number) =>
  z
    .union([z.string().max(max), z.null()])
    .transform((value) => (typeof value === 'string' ? value.trim() || null : null));

const updateSchema = z
  .object({
    displayName: profileField(120),
    company: profileField(160),
    roleTitle: profileField(120),
    aboutWork: profileField(240),
    timezone: z
      .union([z.string().max(64), z.null()])
      .transform((value) => (typeof value === 'string' ? value.trim() || null : null))
      .refine((value) => value === null || isValidTimeZone(value), {
        message: 'timezone must be a valid IANA zone (e.g. Europe/Zagreb)',
      }),
    preferredLanguage: z.enum(SUPPORTED_LANGUAGES),
    languageStrict: z.boolean(),
  })
  .partial();

const suggestionActionSchema = z.object({
  field: z.enum(['company', 'roleTitle']),
  value: z.string().trim().min(1).max(160),
  sourceMemoryId: z.string().uuid(),
});

/**
 * /api/settings/context — the user's instance context (P6.6): profile fields
 * for the prompt now-block, the per-user timezone override, and the language
 * pair. Suggestions (decision 0053) are proposals only: accept applies with
 * provenance, dismiss is remembered — nothing is ever applied silently.
 */
@Controller('settings/context')
@UseGuards(BearerAuthGuard)
export class UserContextController {
  constructor(
    private readonly context: UserContextService,
    @Optional() private readonly suggestionsService?: ContextSuggestionsService,
    @Optional()
    @Inject(INSTANCE_TIMEZONE)
    private readonly instanceTimeZone: string = DEFAULT_INSTANCE_TIMEZONE,
  ) {}

  @Get()
  async get(@Req() request: AuthenticatedRequest): Promise<UserContextDto> {
    const record = await this.context.get(request.principal.userId);
    return this.toDto(record);
  }

  @Put()
  async update(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<UserContextDto> {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const record = await this.context.update(
      { userId: request.principal.userId, orgId: request.principal.orgId },
      parsed.data,
    );
    return this.toDto(record);
  }

  @Get('suggestions')
  async suggestions(@Req() request: AuthenticatedRequest): Promise<ContextSuggestionsDto> {
    if (!this.suggestionsService) return { suggestions: [] };
    return { suggestions: await this.suggestionsService.suggestions(request.principal) };
  }

  @Post('suggestions/accept')
  async accept(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<UserContextDto> {
    const parsed = suggestionActionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const record = await this.context.applySuggestion(
      { userId: request.principal.userId, orgId: request.principal.orgId },
      parsed.data.field,
      parsed.data.value,
      parsed.data.sourceMemoryId,
    );
    return this.toDto(record);
  }

  @Post('suggestions/dismiss')
  async dismiss(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ dismissed: true }> {
    const parsed = suggestionActionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    await this.context.dismissSuggestion(
      { userId: request.principal.userId, orgId: request.principal.orgId },
      parsed.data.field,
      parsed.data.value,
    );
    return { dismissed: true };
  }

  private toDto(record: UserContextRecord): UserContextDto {
    return {
      displayName: record.displayName,
      company: record.company,
      roleTitle: record.roleTitle,
      aboutWork: record.aboutWork,
      timezone: record.timezone,
      effectiveTimezone: record.timezone ?? this.instanceTimeZone,
      preferredLanguage: record.preferredLanguage,
      languageStrict: record.languageStrict,
      companySourceMemoryId: record.companySourceMemoryId,
      roleTitleSourceMemoryId: record.roleTitleSourceMemoryId,
    };
  }
}
