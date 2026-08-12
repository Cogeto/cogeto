import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type {
  ProjectAssignmentDto,
  ProjectAssignmentKind,
  ProjectDto,
  ProjectWriteDto,
  Principal,
} from '@cogeto/shared';
import { CONVERSATION_REF_TYPE, PROJECT_MARKERS } from '@cogeto/shared';
import { DRIZZLE, writeAudit } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { ProjectStore } from './persistence/project.store';
import type { AssignmentRef, SourceRef } from './persistence/project.store';
import type { ProjectRow } from './persistence/tables';
import { LENS_SOURCE_CAP } from './project-lens';

/** Active projects per user: keeps the sidebar picker renderable. */
const MAX_ACTIVE_PROJECTS = 100;

/**
 * What a lensed turn needs to know, resolved in one place (V2.5 item 8.3).
 * `sourceRefs` is a VALUE: retrieval hands it to the memory module, which
 * applies it as an additive pre-filter beside the unchanged gates. Nothing
 * downstream ever joins to a projects table.
 */
export interface ProjectLens {
  projectId: string;
  projectName: string;
  sourceRefs: SourceRef[];
  /** How many sources the project holds; > sourceRefs.length means the
   * Qdrant pre-filter is skipped for this turn and Postgres filters exactly. */
  sourceCount: number;
}

/**
 * The projects surface (V2.5 item 8.3). Per-user by construction: every read
 * and write puts the caller's id in the WHERE clause, and there is no shared
 * arm, because team-shared projects are an explicit non-goal for this version.
 *
 * Nothing in this service decides visibility. It groups containers and hands
 * out ref lists; the gates are the memory module's and are untouched.
 * Decision record: docs/features/projects.md.
 */
@Injectable()
export class ProjectService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly store: ProjectStore,
  ) {}

  async list(principal: Principal, opts: { archived?: boolean } = {}): Promise<ProjectDto[]> {
    const [rows, counts] = await Promise.all([
      this.store.listForOwner(principal.userId, opts),
      this.store.countsForOwner(principal.userId),
    ]);
    return rows.map((row) => toProjectDto(row, counts.get(row.id) ?? {}));
  }

  async get(principal: Principal, id: string): Promise<ProjectDto> {
    const row = await this.require(principal, id);
    const counts = await this.store.countsForOwner(principal.userId);
    return toProjectDto(row, counts.get(row.id) ?? {});
  }

  async assignments(principal: Principal, id: string): Promise<ProjectAssignmentDto[]> {
    await this.require(principal, id);
    const rows = await this.store.listAssignments(id);
    return rows.map((row) => ({
      kind: row.kind,
      refType: row.refType,
      refId: row.refId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async create(principal: Principal, write: ProjectWriteDto): Promise<ProjectDto> {
    const name = write.name.trim();
    if (!name) throw new BadRequestException('a project needs a name');
    // Every project, archived included: the cap counts only active ones, but
    // the colour must stay distinct across all of them, or unarchiving one
    // would collide with a colour handed out while it was away.
    const owned = await this.store.listForOwner(principal.userId);
    if (owned.filter((project) => !project.archived).length >= MAX_ACTIVE_PROJECTS) {
      throw new BadRequestException(
        `you have ${MAX_ACTIVE_PROJECTS} active projects, archive some first`,
      );
    }
    const row = await this.store
      .create(principal.userId, principal.orgId || null, {
        name,
        description: write.description?.trim() || null,
        // A project gets a colour WITHOUT being asked for one. The marker is
        // what the rail groups by, so leaving it null (which every caller
        // did) meant the colour identity existed in the schema and never
        // once rendered. Creation is the moment to decide it, and the user
        // has nothing useful to say at that moment.
        marker: write.marker ?? nextMarker(owned),
        lensEnabled: write.lensEnabled ?? true,
        extractionEnabled: write.extraction?.enabled ?? null,
        extractionFactBudget: write.extraction?.factBudget ?? null,
        extractionRetentionDays: write.extraction?.retentionDays ?? null,
      })
      .catch(rethrowDuplicateName);
    await this.audit(principal, 'project.created', row.id, { archived: false });
    return toProjectDto(row, {});
  }

  async update(
    principal: Principal,
    id: string,
    write: Partial<ProjectWriteDto>,
  ): Promise<ProjectDto> {
    await this.require(principal, id);
    const name = write.name?.trim();
    if (write.name !== undefined && !name) throw new BadRequestException('a project needs a name');
    const row = await this.store
      .update(id, {
        ...(name !== undefined ? { name } : {}),
        ...(write.description !== undefined
          ? { description: write.description?.trim() || null }
          : {}),
        ...(write.marker !== undefined ? { marker: write.marker } : {}),
        ...(write.lensEnabled !== undefined ? { lensEnabled: write.lensEnabled } : {}),
        ...(write.extraction?.enabled !== undefined
          ? { extractionEnabled: write.extraction.enabled }
          : {}),
        ...(write.extraction?.factBudget !== undefined
          ? { extractionFactBudget: write.extraction.factBudget }
          : {}),
        ...(write.extraction?.retentionDays !== undefined
          ? { extractionRetentionDays: write.extraction.retentionDays }
          : {}),
      })
      .catch(rethrowDuplicateName);
    // Structural metadata only: which knobs moved, never the name or the
    // description (the audit trail is org-readable and outlives the row).
    await this.audit(principal, 'project.updated', id, {
      fields: Object.keys(write).sort(),
    });
    const counts = await this.store.countsForOwner(principal.userId);
    return toProjectDto(row, counts.get(id) ?? {});
  }

  /** Archiving is the safe action: one boolean, nothing else moves. */
  async setArchived(principal: Principal, id: string, archived: boolean): Promise<ProjectDto> {
    await this.require(principal, id);
    const row = await this.store.setArchived(id, archived);
    await this.audit(principal, 'project.archived', id, { archived });
    const counts = await this.store.countsForOwner(principal.userId);
    return toProjectDto(row, counts.get(id) ?? {});
  }

  /**
   * Deleting a project NEVER deletes its contents. The row goes, its
   * assignments go with it, and every conversation, source, run and report it
   * grouped remains, unassigned. No saga runs and no receipt is minted,
   * because nothing derived from a source is destroyed (docs/features/projects.md,
   * "Deletion coverage"). The confirmation in the interface says exactly this.
   */
  async delete(principal: Principal, id: string): Promise<{ released: number }> {
    await this.require(principal, id);
    const released = (await this.store.listAssignments(id, { limit: 2000 })).length;
    await this.store.delete(id);
    await this.audit(principal, 'project.deleted', id, { released });
    return { released };
  }

  // ── Assignment ────────────────────────────────────────────────────────────

  /**
   * Assign one thing to a project, move it, or unassign it (`projectId` null).
   * Reversible by construction: the same call in the other direction.
   */
  async assign(
    principal: Principal,
    ref: AssignmentRef,
    projectId: string | null,
  ): Promise<{ projectId: string | null }> {
    if (projectId) await this.require(principal, projectId);
    await this.store.assign(principal.userId, ref, projectId);
    await this.audit(
      principal,
      projectId ? 'project.assigned' : 'project.unassigned',
      projectId ?? ref.refId,
      {
        kind: ref.kind,
        refType: ref.refType,
      },
    );
    return { projectId };
  }

  /** The project one thing belongs to, or null — the surfaces' decoration. */
  projectForRef(ownerId: string, refType: string, refId: string): Promise<ProjectRow | null> {
    return this.store.projectForRef(ownerId, refType, refId);
  }

  /** Batch decoration for a list page: refId → projectId. */
  projectIdsForRefs(
    ownerId: string,
    refType: string,
    refIds: readonly string[],
  ): Promise<Map<string, string>> {
    return this.store.projectIdsForRefs(ownerId, refType, refIds);
  }

  /** Release a set of refs — a removed connector's sub-scopes. */
  releaseRefs(ownerId: string, refType: string, refIds: readonly string[]): Promise<number> {
    return this.store.releaseRefs(ownerId, refType, refIds);
  }

  /** A project's source refs, as the report scope and the lens consume them. */
  sourceRefsFor(projectId: string, cap: number = LENS_SOURCE_CAP): Promise<SourceRef[]> {
    return this.store.sourceRefsFor(projectId, cap);
  }

  // ── The lens ──────────────────────────────────────────────────────────────

  /**
   * The retrieval lens for one conversation, or null when there is nothing to
   * apply: unassigned, or assigned to a project whose lens is off. Null is the
   * pre-feature path exactly, one keyed read and out.
   *
   * A project with NO sources yields an empty ref list, which is a lens that
   * matches nothing — deliberately, because "this project holds no documents
   * yet" is a true answer and silently widening to the whole pool is the
   * behaviour this design refuses.
   */
  async lensForConversation(
    principal: Principal,
    conversationId: string,
  ): Promise<ProjectLens | null> {
    const row = await this.store.projectForRef(
      principal.userId,
      CONVERSATION_REF_TYPE,
      conversationId,
    );
    if (!row || !row.lensEnabled) return null;
    const [sourceRefs, sourceCount] = await Promise.all([
      this.store.sourceRefsFor(row.id, LENS_SOURCE_CAP),
      this.store.sourceCountFor(row.id),
    ]);
    return { projectId: row.id, projectName: row.name, sourceRefs, sourceCount };
  }

  /** The project a conversation is in, lens on or off — the composer's chip. */
  async projectForConversation(
    principal: Principal,
    conversationId: string,
  ): Promise<ProjectRow | null> {
    return this.store.projectForRef(principal.userId, CONVERSATION_REF_TYPE, conversationId);
  }

  private async require(principal: Principal, id: string): Promise<ProjectRow> {
    const row = await this.store.getForOwner(principal.userId, id);
    if (!row) throw new NotFoundException(`project ${id} not found`);
    return row;
  }

  private async audit(
    principal: Principal,
    action: string,
    entityId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await writeAudit(this.db, {
      actor: `user:${principal.userId}`,
      action,
      entityType: 'project',
      entityId,
      detail,
      ownerId: principal.userId,
      orgId: principal.orgId,
    });
  }
}

/**
 * The unique index is the "one Client A per owner" rule; report it as one.
 * The driver's constraint name arrives on the CAUSE, not on the wrapper the
 * query builder throws, so the whole chain is inspected.
 */
function rethrowDuplicateName(error: unknown): never {
  for (let current: unknown = error, hops = 0; current && hops < 5; hops += 1) {
    const detail = current as { constraint?: unknown; message?: unknown; cause?: unknown };
    if (
      detail.constraint === 'project_owner_name_idx' ||
      /project_owner_name_idx/.test(String(detail.message ?? ''))
    ) {
      throw new ConflictException('you already have a project with that name');
    }
    current = detail.cause;
  }
  throw error as Error;
}

export function toProjectDto(
  row: ProjectRow,
  counts: Partial<Record<ProjectAssignmentKind, number>>,
): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    marker: row.marker,
    archived: row.archived,
    lensEnabled: row.lensEnabled,
    extraction: {
      enabled: row.extractionEnabled,
      factBudget: row.extractionFactBudget,
      retentionDays: row.extractionRetentionDays,
    },
    counts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The colour a new project takes: the first one none of the owner's projects
 * is already using, so no two are confusable until there are more projects
 * than colours, and only then does it cycle. Deterministic, so a test can
 * assert it, and no picker exists to argue with.
 */
function nextMarker(existing: readonly { marker: string | null }[]) {
  const taken = new Set(existing.map((project) => project.marker));
  return (
    PROJECT_MARKERS.find((marker) => !taken.has(marker)) ??
    PROJECT_MARKERS[existing.length % PROJECT_MARKERS.length]!
  );
}
