import { Controller, Get, Inject, Optional, Req, UseGuards } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DreamDigestDto, DreamDigestLine, Principal } from '@cogeto/shared';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { MemoryStore } from '../memory/index';
import type { MemoryRow } from '../memory/index';
import { dreamAction } from './persistence/tables';
import type { DreamActionRow } from './persistence/tables';
import { latestFinishedRun } from './dreaming.service';
import { DIGEST_TASK_SECTION } from './digest-task-port';
import type { DigestTaskSectionPort } from './digest-task-port';

/** Lines the panel shows before folding the rest into one overflow line. */
const MAX_LINES = 6;

/**
 * The plain digest (§B.6 v1 form; decision 0011). Owner scoping falls out of
 * the gates: memory details resolve ONLY through the caller's gated reads, so
 * actions on other owners' memories (or on memories deleted since) simply
 * produce no line. dream_run/dream_action are ingestion's own tables; the
 * memory table is never joined.
 */
@Controller('dreaming')
@UseGuards(BearerAuthGuard)
export class DreamingController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly memoryStore: MemoryStore,
    // The tasks module fills this (F3 handoff §3). Optional: absent in
    // ingestion-only tests, where the digest is dreaming-only; present in the
    // app process via TasksModule.forDigest() (a global provider).
    @Optional() @Inject(DIGEST_TASK_SECTION) private readonly taskSection?: DigestTaskSectionPort,
  ) {}

  @Get('latest')
  async latest(@Req() request: AuthenticatedRequest): Promise<DreamDigestDto> {
    const run = await latestFinishedRun(this.db);
    // The consolidation section: the latest finished run's actions (empty when
    // there is no run yet). Capped and folded by buildLines.
    let dreamingLines: DreamDigestLine[] = [];
    if (run) {
      const actions = await this.db.select().from(dreamAction).where(eq(dreamAction.runId, run.id));
      dreamingLines = (await this.buildLines(request.principal, actions)).map((l) => ({
        ...l,
        section: 'consolidation' as const,
      }));
    }
    // The tasks section: reminders + updates, independent of whether a dream
    // run exists (a due task must surface even on a store that never dreamt).
    const taskLines =
      (await this.taskSection?.taskLines(request.principal, {
        scopeFrom: run?.scopeFrom ?? null,
      })) ?? [];
    return {
      runId: run?.id ?? null,
      finishedAt: run?.finishedAt?.toISOString() ?? null,
      // Silence on empty (F2 §2 / F3 §3): an empty run AND an empty task set
      // render no panel — the frontend hides on `lines.length === 0`.
      lines: [...dreamingLines, ...taskLines],
    };
  }

  private async buildLines(
    principal: Principal,
    actions: DreamActionRow[],
  ): Promise<DreamDigestLine[]> {
    if (actions.length === 0) return [];
    const ids = [...new Set(actions.map((a) => a.memoryId))];
    const rows = await this.memoryStore.getManyForPrincipal(principal, ids, {
      includeSensitive: true,
    });
    const visible = new Map(rows.map((row) => [row.id, row]));

    // Priority: conflicts first (they want attention), then merges and
    // updates (the work done), then quiet commitments, then the aggregate.
    const lines: DreamDigestLine[] = [];
    const byPass = (pass: DreamActionRow['pass']) =>
      actions.filter((a) => a.pass === pass && visible.has(a.memoryId));

    for (const action of byPass('contradiction')) {
      lines.push({
        text: `Found a conflict about ${label(visible.get(action.memoryId)!)} — your call`,
        href: '/review?tab=contradicted',
      });
    }
    for (const action of byPass('dedup')) {
      lines.push({
        text: `Merged two notes about ${label(visible.get(action.memoryId)!)}`,
        href: `/memories?open=${action.memoryId}`,
      });
    }
    for (const action of byPass('supersession')) {
      lines.push({
        text: `Updated ${label(visible.get(action.memoryId)!)} — a newer fact replaced an older one`,
        href: `/memories?open=${action.memoryId}`,
      });
    }
    for (const action of byPass('dormant')) {
      lines.push({
        text: `A commitment about ${label(visible.get(action.memoryId)!)} has gone quiet`,
        href: `/memories?open=${action.memoryId}`,
      });
    }
    const outdated = byPass('staleness');
    if (outdated.length > 0) {
      lines.push({
        text:
          outdated.length === 1
            ? `Marked 1 memory outdated — its date passed`
            : `Marked ${outdated.length} memories outdated — their dates passed`,
        href: '/memories?status=outdated',
      });
    }

    if (lines.length > MAX_LINES) {
      const shown = lines.slice(0, MAX_LINES - 1);
      shown.push({
        text: `…and ${lines.length - (MAX_LINES - 1)} more changes`,
        href: '/memories',
      });
      return shown;
    }
    return lines;
  }
}

/** A short human handle for a memory: its subject, first entity, or content. */
function label(row: MemoryRow): string {
  if (row.subjectEntity) return row.subjectEntity;
  if (row.entities.length > 0) return row.entities[0]!;
  const content = (row.content ?? '').trim();
  return content.length > 40 ? `“${content.slice(0, 37)}…”` : `“${content}”`;
}
