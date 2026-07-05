import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { MemoryListItem, MemoryPage } from '@cogeto/shared';
import { MEMORY_SCOPES, MEMORY_STATUSES } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { MemoryStore } from './memory.store';
import type { MemoryFilters } from './memory.store';
import { toListItem } from './list-item';

/** Zod at the boundary: the list's query surface and the two action bodies. */
const listQuerySchema = z.object({
  q: z.string().max(500).optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
  status: z.enum(MEMORY_STATUSES).optional(),
  sensitive: z.enum(['true', 'false']).optional(),
  entity: z.string().max(200).optional(),
  includeSensitive: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const editSchema = z.object({
  content: z
    .string()
    .max(4_000, 'memory content is too long (max 4000 characters)')
    .refine((value) => value.trim().length > 0, 'memory content must not be blank'),
});

const sensitiveSchema = z.object({ sensitive: z.boolean() });

/**
 * The dashboard's memory surface (S3-B) — thin routes over the MemoryStore
 * aggregate. Every read passes the gates; every action is owner-checked and
 * audited inside the aggregate; illegal transitions surface as typed 400s
 * whose message the UI shows verbatim.
 */
@Controller('memories')
@UseGuards(BearerAuthGuard)
export class MemoriesController {
  constructor(private readonly store: MemoryStore) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown): Promise<MemoryPage> {
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const q = parsed.data;
    const opts = {
      includeSensitive: q.includeSensitive === 'true',
      scope: q.scope,
      status: q.status,
      sensitiveOnly: q.sensitive === 'true',
      entity: q.entity,
    } satisfies MemoryFilters & { includeSensitive: boolean };

    if (q.q?.trim()) {
      // Text search ranks by relevance; pagination applies within the ranked
      // slice (topK caps the search — fine at dashboard scale).
      const hits = await this.store.ftsSearch(request.principal, q.q, {
        ...opts,
        topK: q.offset + q.limit,
      });
      const total = await this.store.countForPrincipal(request.principal, opts);
      return { items: hits.slice(q.offset).map((h) => toListItem(h.memory)), total };
    }

    const [rows, total] = await Promise.all([
      this.store.listForPrincipal(request.principal, { ...opts, limit: q.limit, offset: q.offset }),
      this.store.countForPrincipal(request.principal, opts),
    ]);
    return { items: rows.map(toListItem), total };
  }

  /** One memory — detail drawer + chat citation chips. */
  @Get(':id')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MemoryListItem> {
    // Sensitive opt-in mirrors the list: the store returns it owner-only anyway.
    const row = await this.store.getForPrincipal(request.principal, id, {
      includeSensitive: true,
    });
    if (!row) throw new NotFoundException(`memory ${id} not found`);
    return toListItem(row);
  }

  /** The supersession chain, oldest → newest — the history panel (§B.2). */
  @Get(':id/chain')
  async chain(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MemoryListItem[]> {
    const rows = await this.store.getChain(request.principal, id, { includeSensitive: true });
    if (rows.length === 0) throw new NotFoundException(`memory ${id} not found`);
    return rows.map(toListItem);
  }

  /** Review approval: uncertain → user_approved, owner-only (S3-B). */
  @Post(':id/approve')
  async approve(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MemoryListItem> {
    const row = await this.store.transition(
      { kind: 'user', userId: request.principal.userId },
      id,
      'user_approved',
      'dashboard review approval',
    );
    return toListItem(row);
  }

  @Post(':id/mark-outdated')
  async markOutdated(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MemoryListItem> {
    const row = await this.store.transition(
      { kind: 'user', userId: request.principal.userId },
      id,
      'outdated',
      'dashboard action',
    );
    return toListItem(row);
  }

  /** Sensitive gate toggle — row + Qdrant payload in the two-store pattern. */
  @Post(':id/sensitive')
  async setSensitive(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<MemoryListItem> {
    const parsed = sensitiveSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('body must be { sensitive: boolean }');
    const row = await this.store.toggleSensitive(request.principal, id, parsed.data.sensitive);
    return toListItem(row);
  }

  /** Edit = supersession (0006 ruling 3): returns the successor. */
  @Post(':id/edit')
  async edit(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<{ predecessor: MemoryListItem; successor: MemoryListItem }> {
    const parsed = editSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const { predecessor, successor } = await this.store.editContent(
      request.principal,
      id,
      parsed.data.content.trim(),
    );
    return { predecessor: toListItem(predecessor), successor: toListItem(successor) };
  }

  /** Review rejection (0006 ruling 4): audited removal of row + point. */
  @Post(':id/reject')
  async reject(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ rejected: boolean }> {
    const removed = await this.store.rejectUncertain(request.principal, id);
    if (!removed) throw new NotFoundException(`memory ${id} not found`);
    return { rejected: true };
  }
}
