import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { NoteCaptured, NoteDto, NoteStatusDto } from '@cogeto/shared';
import { MEMORY_SCOPES } from '@cogeto/shared';
import { parseOrBadRequest, RateLimit, RateLimitGuard, userError } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { NotesService } from './notes.service';
import { UserSettingsService } from '../settings/index';

/** Zod at the boundary: non-blank, bounded content; optional scope. */
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
    const parsed = parseOrBadRequest(captureSchema, body);
    // An omitted scope falls back to the user's saved default —
    // the same rule uploads follow, so the Settings toggle now governs BOTH.
    const scope = parsed.scope ?? (await this.settings.get(request.principal)).defaultScope;
    const row = await this.notes.createNote(request.principal, parsed.content, scope);
    return { id: row.id, createdAt: row.createdAt.toISOString() };
  }

  /** The originating note text — the source drawer target (owner-only). */
  @Get(':id')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NoteDto> {
    const row = await this.notes.getNoteForOwner(request.principal, id);
    if (!row) throw userError.notFound('note.notFound', 'note {{id}} not found', { id });
    return { id: row.id, content: row.content, createdAt: row.createdAt.toISOString() };
  }

  /** Pipeline progress for the capture card's processing indicator. */
  @Get(':id/status')
  async status(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NoteStatusDto> {
    const row = await this.notes.getNoteForOwner(request.principal, id);
    if (!row) throw userError.notFound('note.notFound', 'note {{id}} not found', { id });
    return { state: await this.notes.getProcessingState(id) };
  }
}
