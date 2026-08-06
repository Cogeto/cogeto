import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { desc, eq, inArray } from 'drizzle-orm';
import type { VerificationDto } from '@cogeto/shared';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { MemoryStore } from '../memory/index';
import { verificationResult } from './persistence/tables';

/**
 * GET /api/memories/:id/verification — the spec §2 verdict behind a memory's
 * status, for the dashboard's verification panel. Lives in ingestion (its
 * table); the read is gated by resolving the memory through MemoryStore
 * first, so verdicts leak exactly as much as memories do: not at all.
 */
@Controller('memories')
@UseGuards(BearerAuthGuard)
export class VerificationController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly memoryStore: MemoryStore,
  ) {}

  @Get(':id/verification')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VerificationDto> {
    const memory = await this.memoryStore.getForPrincipal(request.principal, id, {
      includeSensitive: true,
    });
    if (!memory) throw new NotFoundException(`memory ${id} not found`);

    const rows = await this.db
      .select()
      .from(verificationResult)
      .where(eq(verificationResult.memoryId, id))
      .orderBy(desc(verificationResult.createdAt))
      .limit(1);
    const row = rows[0];
    // User-authored rows (edit successors, future manual facts) have no
    // verification pass — that is a fact about them, not an error.
    if (!row) throw new NotFoundException(`memory ${id} has no verification result`);
    return {
      verdict: row.verdict,
      reason: row.reason,
      promptVersion: row.promptVersion,
      sourceSpan: row.sourceSpan,
      hedgePhrase: row.hedgePhrase,
      spanLocators: row.spanLocators ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/**
 * Grouped verification evidence for one page of memories (V2.2 item 5.2), a
 * plain function in the `latestGateRefusalFor` shape: the inspection view
 * joins facts to their verdicts in one query, and the table stays named only
 * inside its owner.
 */
export async function verificationsForMemories(
  db: Db,
  memoryIds: readonly string[],
): Promise<Map<string, VerificationDto>> {
  const out = new Map<string, VerificationDto>();
  if (memoryIds.length === 0) return out;
  const rows = await db
    .select()
    .from(verificationResult)
    .where(inArray(verificationResult.memoryId, [...memoryIds]))
    .orderBy(verificationResult.createdAt);
  // Later rows overwrite earlier ones, so the LATEST verification wins,
  // matching the singular endpoint's `order by created_at desc limit 1`.
  for (const row of rows) {
    out.set(row.memoryId, {
      verdict: row.verdict,
      reason: row.reason,
      promptVersion: row.promptVersion,
      sourceSpan: row.sourceSpan,
      hedgePhrase: row.hedgePhrase,
      spanLocators: row.spanLocators ?? null,
      createdAt: row.createdAt.toISOString(),
    });
  }
  return out;
}
