import { Controller, Get, Inject, Optional, Req, UseGuards } from '@nestjs/common';
import type { DreamDigestDto } from '@cogeto/shared';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { MemoryStore } from '../memory/index';
import { buildDreamDigest } from './dream-digest';
import { DIGEST_TASK_SECTION } from './digest-task-port';
import type { DigestTaskSectionPort } from './digest-task-port';

/**
 * The plain digest (§B.6 v1 form; decision 0011). A thin wrapper over
 * {@link buildDreamDigest} — the same builder the attention feed (Post-v1
 * Priority 2) reuses, so there is exactly one digest, gated once. Owner scoping
 * falls out of the gates inside the builder.
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
    return buildDreamDigest(this.db, this.memoryStore, request.principal, {
      taskSection: this.taskSection,
    });
  }
}
