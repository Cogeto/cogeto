import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { MemoryListItem, PointInTimeDto, TimelineDiffDto, TimelineDto } from '@cogeto/shared';
import { BearerAuthGuard, UserDirectory } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { TimelineService } from './timeline.service';

/** Zod at the boundary: a subject entity, and ISO instants for the temporal views. */
const subjectSchema = z.object({
  subject: z.string().trim().min(1, 'subject is required').max(200),
});
const isoInstant = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO date-time');
const atSchema = subjectSchema.extend({ at: isoInstant });
const diffSchema = subjectSchema.extend({ from: isoInstant, to: isoInstant });

/**
 * The time-travel read surface (decision 0012) — thin routes over the
 * {@link TimelineService} composition. Every read is Principal-gated inside the
 * MemoryStore primitives the service calls; this controller only parses the
 * query and attributes cited shared facts to their owner (O2-B), name-only
 * (visibility was already decided by the gates).
 */
@Controller('timeline')
@UseGuards(BearerAuthGuard)
export class TimelineController {
  constructor(
    private readonly timeline: TimelineService,
    private readonly directory: UserDirectory,
  ) {}

  /** The subject's full history as validity spans. */
  @Get()
  async subject(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<TimelineDto> {
    const { subject } = this.parse(subjectSchema, query);
    const result = await this.timeline.forSubject(request.principal, subject);
    await this.attribute(result.spans.map((span) => span.memory));
    return result;
  }

  /** The subject as understood at an instant, each fact labelled with its later fate. */
  @Get('at')
  async at(@Req() request: AuthenticatedRequest, @Query() query: unknown): Promise<PointInTimeDto> {
    const { subject, at } = this.parse(atSchema, query);
    const result = await this.timeline.pointInTime(request.principal, subject, new Date(at));
    await this.attribute(result.facts.map((fact) => fact.memory));
    return result;
  }

  /** The diff between two instants: added / changed / removed / unchanged. */
  @Get('diff')
  async diff(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<TimelineDiffDto> {
    const { subject, from, to } = this.parse(diffSchema, query);
    const result = await this.timeline.diff(
      request.principal,
      subject,
      new Date(from),
      new Date(to),
    );
    await this.attribute([
      ...result.added,
      ...result.removed,
      ...result.unchanged,
      ...result.changed.flatMap((change) => [change.before, change.after]),
    ]);
    return result;
  }

  private parse<T>(schema: z.ZodType<T>, query: unknown): T {
    const parsed = schema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
    }
    return parsed.data;
  }

  /** Fill `ownerName` in place so shared facts owned by teammates are attributable. */
  private async attribute(items: MemoryListItem[]): Promise<void> {
    if (items.length === 0) return;
    const names = await this.directory.displayNames(items.map((item) => item.ownerId));
    for (const item of items) item.ownerName = names.get(item.ownerId) ?? null;
  }
}
