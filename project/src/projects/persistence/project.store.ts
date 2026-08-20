import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { ProjectAssignmentKind } from '@cogeto/shared';
import { DRIZZLE } from '../../infrastructure/index';
import type { Db, Tx } from '../../infrastructure/index';
import { project, projectAssignment } from './tables';
import type { ProjectAssignmentRow, ProjectRow } from './tables';

/** One thing a project groups, addressed the way the table addresses it. */
export interface AssignmentRef {
  kind: ProjectAssignmentKind;
  /** The source type for `source` refs; the kind itself for the other four. */
  refType: string;
  refId: string;
}

/** A source, in the shape retrieval and the report scope both consume. */
export interface SourceRef {
  sourceType: string;
  sourceId: string;
}

export interface ProjectWrite {
  name: string;
  description?: string | null;
  marker?: string | null;
  lensEnabled?: boolean;
  extractionEnabled?: boolean | null;
  extractionFactBudget?: number | null;
  extractionRetentionDays?: number | null;
}

/**
 * Every read here takes an owner id and puts it in the WHERE clause, because a
 * project is per-user (V2.5 item 8.3) and there is no shared arm to widen it
 * with. This store is the ONLY place the two tables are named.
 */
@Injectable()
export class ProjectStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  // ── Projects ──────────────────────────────────────────────────────────────

  async listForOwner(
    ownerId: string,
    opts: { archived?: boolean; spaceId?: string } = {},
  ): Promise<ProjectRow[]> {
    const clauses: SQL[] = [eq(project.ownerId, ownerId)];
    if (opts.archived !== undefined) clauses.push(eq(project.archived, opts.archived));
    // The caller's space (docs/features/spaces.md): the rail shows the current
    // space's projects only. Optional so pre-spaces callers resolve to the
    // default space at the service layer, never to "all spaces".
    if (opts.spaceId !== undefined) clauses.push(eq(project.spaceId, opts.spaceId));
    return this.db
      .select()
      .from(project)
      .where(and(...clauses))
      .orderBy(asc(project.archived), desc(project.updatedAt), project.id);
  }

  async getForOwner(ownerId: string, id: string, spaceId: string): Promise<ProjectRow | null> {
    const rows = await this.db
      .select()
      .from(project)
      .where(
        and(
          eq(project.id, id),
          eq(project.ownerId, ownerId),
          // The by-id read is sealed like the listing (docs/features/
          // spaces.md): a project in another space is not found, even for
          // its owner, so no update, archive, delete or assignment can act
          // across the wall through this funnel.
          eq(project.spaceId, spaceId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async create(
    ownerId: string,
    orgId: string | null,
    write: ProjectWrite,
    spaceId: string,
  ): Promise<ProjectRow> {
    const [row] = await this.db
      .insert(project)
      .values({
        ownerId,
        orgId,
        // The caller's current space, required: in this feature the space is
        // never optional, never defaulted, never inferred
        // (docs/features/spaces.md section 6d).
        spaceId,
        name: write.name,
        description: write.description ?? null,
        marker: (write.marker ?? null) as ProjectRow['marker'],
        lensEnabled: write.lensEnabled ?? true,
        extractionEnabled: write.extractionEnabled ?? null,
        extractionFactBudget: write.extractionFactBudget ?? null,
        extractionRetentionDays: write.extractionRetentionDays ?? null,
      })
      .returning();
    return row!;
  }

  async update(id: string, write: Partial<ProjectWrite>): Promise<ProjectRow> {
    const [row] = await this.db
      .update(project)
      .set({
        ...(write.name !== undefined ? { name: write.name } : {}),
        ...(write.description !== undefined ? { description: write.description } : {}),
        ...(write.marker !== undefined ? { marker: write.marker as ProjectRow['marker'] } : {}),
        ...(write.lensEnabled !== undefined ? { lensEnabled: write.lensEnabled } : {}),
        ...(write.extractionEnabled !== undefined
          ? { extractionEnabled: write.extractionEnabled }
          : {}),
        ...(write.extractionFactBudget !== undefined
          ? { extractionFactBudget: write.extractionFactBudget }
          : {}),
        ...(write.extractionRetentionDays !== undefined
          ? { extractionRetentionDays: write.extractionRetentionDays }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(project.id, id))
      .returning();
    return row!;
  }

  async setArchived(id: string, archived: boolean): Promise<ProjectRow> {
    const [row] = await this.db
      .update(project)
      .set({ archived, updatedAt: new Date() })
      .where(eq(project.id, id))
      .returning();
    return row!;
  }

  /**
   * Deletes the project row. The assignment rows go with it by FK CASCADE and
   * NOTHING ELSE MOVES: the conversations, sources, runs and reports it
   * grouped all remain, unassigned. There is no saga and no receipt here,
   * because nothing derived from a source is destroyed.
   */
  async delete(id: string): Promise<void> {
    await this.db.delete(project).where(eq(project.id, id));
  }

  // ── Assignments ───────────────────────────────────────────────────────────

  /**
   * Assign one thing to one project, or unassign it (`projectId = null`).
   * At most one project per thing: an existing assignment for the same ref is
   * replaced, which is what makes "move to another project" one call.
   */
  async assign(
    ownerId: string,
    ref: AssignmentRef,
    projectId: string | null,
  ): Promise<ProjectAssignmentRow | null> {
    return this.db.transaction(async (tx) => {
      await tx
        .delete(projectAssignment)
        .where(
          and(
            eq(projectAssignment.refType, ref.refType),
            eq(projectAssignment.refId, ref.refId),
            eq(projectAssignment.ownerId, ownerId),
          ),
        );
      if (!projectId) return null;
      const [row] = await tx
        .insert(projectAssignment)
        .values({
          projectId,
          ownerId,
          kind: ref.kind,
          refType: ref.refType,
          refId: ref.refId,
        })
        .returning();
      return row!;
    });
  }

  /**
   * Records an assignment inside the CALLER's transaction, without disturbing
   * an existing one. This is the propagation path: a connector sub-scope or a
   * research run stamping the source it just created, in the same transaction
   * that creates it, so no window exists where the source has no project.
   * Silently does nothing when the ref is already assigned somewhere.
   */
  async assignInTx(
    tx: Tx,
    ownerId: string,
    ref: AssignmentRef,
    projectId: string,
  ): Promise<boolean> {
    const existing = await tx
      .select({ id: projectAssignment.id })
      .from(projectAssignment)
      .where(
        and(eq(projectAssignment.refType, ref.refType), eq(projectAssignment.refId, ref.refId)),
      )
      .limit(1);
    if (existing.length > 0) return false;
    await tx.insert(projectAssignment).values({
      projectId,
      ownerId,
      kind: ref.kind,
      refType: ref.refType,
      refId: ref.refId,
    });
    return true;
  }

  async listAssignments(
    projectId: string,
    opts: { kind?: ProjectAssignmentKind; limit?: number } = {},
  ): Promise<ProjectAssignmentRow[]> {
    const clauses: SQL[] = [eq(projectAssignment.projectId, projectId)];
    if (opts.kind) clauses.push(eq(projectAssignment.kind, opts.kind));
    return this.db
      .select()
      .from(projectAssignment)
      .where(and(...clauses))
      .orderBy(desc(projectAssignment.createdAt), projectAssignment.id)
      .limit(Math.min(opts.limit ?? 500, 2000));
  }

  /** Per-kind counts for one owner's projects, in one grouped query. */
  async countsForOwner(
    ownerId: string,
  ): Promise<Map<string, Partial<Record<ProjectAssignmentKind, number>>>> {
    const rows = await this.db
      .select({
        projectId: projectAssignment.projectId,
        kind: projectAssignment.kind,
        n: sql<number>`count(*)::int`,
      })
      .from(projectAssignment)
      .where(eq(projectAssignment.ownerId, ownerId))
      .groupBy(projectAssignment.projectId, projectAssignment.kind);
    const out = new Map<string, Partial<Record<ProjectAssignmentKind, number>>>();
    for (const row of rows) {
      const entry = out.get(row.projectId) ?? {};
      entry[row.kind] = row.n;
      out.set(row.projectId, entry);
    }
    return out;
  }

  /** The project one thing belongs to, or null. One indexed keyed read. */
  async projectForRef(ownerId: string, refType: string, refId: string): Promise<ProjectRow | null> {
    const rows = await this.db
      .select({ row: project })
      .from(projectAssignment)
      .innerJoin(project, eq(project.id, projectAssignment.projectId))
      .where(
        and(
          eq(projectAssignment.refType, refType),
          eq(projectAssignment.refId, refId),
          eq(projectAssignment.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0]?.row ?? null;
  }

  /**
   * The project a ref belongs to, WITHOUT an owner argument: the ingestion
   * pipeline runs as the system on a source whose owner it already resolved,
   * and the assignment is keyed uniquely by (ref_type, ref_id) anyway. Used
   * ONLY by the extraction-policy port; every request-path read takes the
   * owner.
   */
  async projectByRef(refType: string, refId: string): Promise<ProjectRow | null> {
    const rows = await this.db
      .select({ row: project })
      .from(projectAssignment)
      .innerJoin(project, eq(project.id, projectAssignment.projectId))
      .where(and(eq(projectAssignment.refType, refType), eq(projectAssignment.refId, refId)))
      .limit(1);
    return rows[0]?.row ?? null;
  }

  /**
   * The project ids for a batch of refs of ONE type — the list surfaces'
   * decoration query (a conversation list, a page of source-catalog rows),
   * one indexed read rather than one per row.
   */
  async projectIdsForRefs(
    ownerId: string,
    refType: string,
    refIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (refIds.length === 0) return new Map();
    const rows = await this.db
      .select({ refId: projectAssignment.refId, projectId: projectAssignment.projectId })
      .from(projectAssignment)
      .where(
        and(
          eq(projectAssignment.ownerId, ownerId),
          eq(projectAssignment.refType, refType),
          inArray(projectAssignment.refId, [...refIds]),
        ),
      );
    return new Map(rows.map((row) => [row.refId, row.projectId]));
  }

  /**
   * A project's SOURCE refs, capped. This is the lens list and the
   * project-scoped report's enumeration, and it is deliberately a VALUE handed
   * to other modules: neither retrieval nor memory nor reports ever joins to
   * this table, which is what keeps the association on the container.
   */
  async sourceRefsFor(projectId: string, cap: number): Promise<SourceRef[]> {
    const rows = await this.db
      .select({ refType: projectAssignment.refType, refId: projectAssignment.refId })
      .from(projectAssignment)
      .where(and(eq(projectAssignment.projectId, projectId), eq(projectAssignment.kind, 'source')))
      .orderBy(desc(projectAssignment.createdAt), projectAssignment.id)
      .limit(cap);
    return rows.map((row) => ({ sourceType: row.refType, sourceId: row.refId }));
  }

  /** How many sources the project groups — the honest "N of cap" number. */
  async sourceCountFor(projectId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(projectAssignment)
      .where(and(eq(projectAssignment.projectId, projectId), eq(projectAssignment.kind, 'source')));
    return rows[0]?.n ?? 0;
  }

  /**
   * Releases the assignment of one ref inside the caller's transaction — the
   * deletion cascade's arm. Returns how many rows went, for the receipt.
   */
  async releaseRefInTx(tx: Tx, refType: string, refId: string): Promise<number> {
    const rows = await tx
      .delete(projectAssignment)
      .where(and(eq(projectAssignment.refType, refType), eq(projectAssignment.refId, refId)))
      .returning({ id: projectAssignment.id });
    return rows.length;
  }

  /** Releases a set of refs of one type — a removed connector's sub-scopes. */
  async releaseRefs(ownerId: string, refType: string, refIds: readonly string[]): Promise<number> {
    if (refIds.length === 0) return 0;
    const rows = await this.db
      .delete(projectAssignment)
      .where(
        and(
          eq(projectAssignment.ownerId, ownerId),
          eq(projectAssignment.refType, refType),
          inArray(projectAssignment.refId, [...refIds]),
        ),
      )
      .returning({ id: projectAssignment.id });
    return rows.length;
  }
}
