import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { MemoryChangeDto, MemoryListItem, MemoryPage } from '@cogeto/shared';
import { MEMORY_SCOPES, MEMORY_STATUSES, UNCERTAINTY_REASONS } from '@cogeto/shared';
import { BearerAuthGuard, UserDirectory } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { MEMORY_ELIGIBILITY_HOOK } from './eligibility-hook';
import type { MemoryEligibilityHook } from './eligibility-hook';
import { MemoryStore } from './memory.store';
import type { MemoryFilters } from './memory.store';
import { toListItem } from './list-item';
import { parseOrBadRequest } from '../infrastructure/index';

/** Zod at the boundary: the list's query surface and the two action bodies. */
const listQuerySchema = z.object({
  q: z.string().max(500).optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
  status: z.enum(MEMORY_STATUSES).optional(),
  sensitive: z.enum(['true', 'false']).optional(),
  entity: z.string().max(200).optional(),
  /** The admission taxonomy arm (V2.2 item 5.2, the filtered fact search). */
  uncertaintyReason: z.enum(UNCERTAINTY_REASONS).optional(),
  includeSensitive: z.enum(['true', 'false']).optional(),
  mine: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).prefault(25),
  offset: z.coerce.number().int().min(0).prefault(0),
});

const changesQuerySchema = z.object({
  since: z.iso.datetime({ offset: true }),
  limit: z.coerce.number().int().min(1).max(200).prefault(100),
});

const editSchema = z.object({
  content: z
    .string()
    .max(4_000, 'memory content is too long (max 4000 characters)')
    .refine((value) => value.trim().length > 0, 'memory content must not be blank'),
});

const sensitiveSchema = z.object({ sensitive: z.boolean() });
const scopeSchema = z.object({ scope: z.enum(MEMORY_SCOPES) });

/**
 * The dashboard's memory surface — thin routes over the MemoryStore
 * aggregate. Every read passes the gates; every action is owner-checked and
 * audited inside the aggregate; illegal transitions surface as typed 400s
 * whose message the UI shows verbatim.
 */
@Controller('memories')
@UseGuards(BearerAuthGuard)
export class MemoriesController {
  constructor(
    private readonly store: MemoryStore,
    private readonly directory: UserDirectory,
    @Optional()
    @Inject(MEMORY_ELIGIBILITY_HOOK)
    private readonly eligibilityHook?: MemoryEligibilityHook | null,
  ) {}

  /** Attach owner display names so shared rows owned by others are
   * attributable in the list and drawer. Name-only — visibility was already
   * decided by the gates the store applied. */
  private async withOwnerNames(items: MemoryListItem[]): Promise<MemoryListItem[]> {
    if (items.length === 0) return items;
    const names = await this.directory.displayNames(items.map((i) => i.ownerId));
    return items.map((i) => ({ ...i, ownerName: names.get(i.ownerId) ?? null }));
  }

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown): Promise<MemoryPage> {
    const parsed = parseOrBadRequest(listQuerySchema, query);
    const q = parsed;
    const opts = {
      includeSensitive: q.includeSensitive === 'true',
      scope: q.scope,
      status: q.status,
      sensitiveOnly: q.sensitive === 'true',
      entity: q.entity,
      uncertaintyReason: q.uncertaintyReason,
      mine: q.mine === 'true',
    } satisfies MemoryFilters & { includeSensitive: boolean };

    if (q.q?.trim()) {
      // Text search ranks by relevance; pagination applies within the ranked
      // slice (topK caps the search — fine at dashboard scale).
      const hits = await this.store.ftsSearch(request.principal, q.q, {
        ...opts,
        topK: q.offset + q.limit,
      });
      const total = await this.store.countForPrincipal(request.principal, opts);
      const items = await this.withOwnerNames(
        hits.slice(q.offset).map((h) => toListItem(h.memory)),
      );
      return { items, total };
    }

    const [rows, total] = await Promise.all([
      this.store.listForPrincipal(request.principal, { ...opts, limit: q.limit, offset: q.offset }),
      this.store.countForPrincipal(request.principal, opts),
    ]);
    return { items: await this.withOwnerNames(rows.map(toListItem)), total };
  }

  /**
   * The change feed for the filtered search's changed-since mode (V2.2 item
   * 5.2): learned, status-changed and superseded events since a date, each
   * carrying the memory as it is NOW through the gated read. Declared before
   * `:id` so the literal path is not swallowed by the parameter route.
   */
  @Get('changes')
  async changes(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<MemoryChangeDto[]> {
    const parsed = parseOrBadRequest(changesQuerySchema, query ?? {});
    const changes = await this.store.changesSince(request.principal, new Date(parsed.since), {
      includeSensitive: true,
      limit: parsed.limit,
    });
    const items = await this.withOwnerNames(changes.map((change) => toListItem(change.memory)));
    return changes.map((change, i) => ({
      kind: change.kind,
      at: change.at.toISOString(),
      memory: items[i]!,
      detail: {
        from: change.detail.from ?? null,
        to: change.detail.to ?? null,
        supersededBy: change.detail.supersededBy ?? null,
      },
    }));
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
    return (await this.withOwnerNames([toListItem(row)]))[0]!;
  }

  /** The supersession chain, oldest → newest — the history panel (spec §6). */
  @Get(':id/chain')
  async chain(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MemoryListItem[]> {
    const rows = await this.store.getChain(request.principal, id, { includeSensitive: true });
    if (rows.length === 0) throw new NotFoundException(`memory ${id} not found`);
    return this.withOwnerNames(rows.map(toListItem));
  }

  /** Review approval: uncertain → user_approved, owner-only. */
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
    // Eligibility re-pair (V2.3 item 6.1): a confirmed fact enters the
    // contradiction candidate pool NOW, not at the next nightly pass. The
    // approval already committed; a failed enqueue must not un-approve it,
    // and the nightly batch remains the backstop.
    try {
      await this.eligibilityHook?.onEligibilityChanged(row);
    } catch {
      // Swallowed by design: the dreaming cycle re-covers this fact.
    }
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

  /** Scope change: private↔shared, owner-only, row + Qdrant payload. */
  @Post(':id/scope')
  async setScope(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<MemoryListItem> {
    const parsed = scopeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('body must be { scope: private|shared }');
    const row = await this.store.setScope(request.principal, id, parsed.data.scope);
    return toListItem(row);
  }

  /** Edit = supersession (0006 ruling 3): returns the successor. */
  @Post(':id/edit')
  async edit(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<{ predecessor: MemoryListItem; successor: MemoryListItem }> {
    const parsed = parseOrBadRequest(editSchema, body);
    const { predecessor, successor } = await this.store.editContent(
      request.principal,
      id,
      parsed.content.trim(),
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
