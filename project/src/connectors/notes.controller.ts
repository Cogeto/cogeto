import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { NoteCaptured, NoteDto, NoteStatusDto } from '@cogeto/shared';
import { MEMORY_SCOPES } from '@cogeto/shared';
import { RateLimit, RateLimitGuard } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { NotesService } from './notes.service';
import { UserSettingsService } from './user-settings.service';

/** Zod at the boundary: non-blank, bounded content; optional scope (O2-B). */
const captureSchema = z.object({
  content: z
    .string()
    .max(20_000, 'note is too long (max 20000 characters)')
    .refine((value) => value.trim().length > 0, 'note content must not be blank'),
  scope: z.enum(MEMORY_SCOPES).optional(),
});

@Controller('notes')
@UseGuards(BearerAuthGuard)
export class NotesController {
  constructor(
    private readonly notes: NotesService,
    private readonly settings: UserSettingsService,
  ) {}

  /** Capture a note and (transactionally) enqueue its pipeline job. */
  @Post()
  @UseGuards(RateLimitGuard)
  @RateLimit('capture')
  async capture(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<NoteCaptured> {
    const parsed = captureSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    // An omitted scope falls back to the user's saved default (§A.9, O1-C) —
    // the same rule uploads follow, so the Settings toggle now governs BOTH.
    const scope = parsed.data.scope ?? (await this.settings.get(request.principal)).defaultScope;
    const row = await this.notes.createNote(request.principal, parsed.data.content, scope);
    return { id: row.id, createdAt: row.createdAt.toISOString() };
  }

  /** The originating note text — the source drawer target (owner-only). */
  @Get(':id')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NoteDto> {
    const row = await this.notes.getNoteForOwner(request.principal, id);
    if (!row) throw new NotFoundException(`note ${id} not found`);
    return { id: row.id, content: row.content, createdAt: row.createdAt.toISOString() };
  }

  /** Pipeline progress for the capture card's processing indicator. */
  @Get(':id/status')
  async status(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NoteStatusDto> {
    const row = await this.notes.getNoteForOwner(request.principal, id);
    if (!row) throw new NotFoundException(`note ${id} not found`);
    return { state: await this.notes.getProcessingState(id) };
  }
}
