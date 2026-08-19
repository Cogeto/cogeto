import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
import type { Principal, SpaceDeletionPlanDto } from '@cogeto/shared';
import {
  DRIZZLE,
  untranslatedError,
  withTransactionalEnqueue,
  writeAudit,
} from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import {
  DeletionSaga,
  listAllFileSourcesForSpace,
  MemoryObjectStore,
  SOURCE_DELETIONS,
} from '../memory/index';
import type { SourceDeletion } from '../memory/index';
import { space } from './persistence/tables';
import { SPACE_CLEANUPS } from './space-cleanup.port';
import type { SpaceCleanup } from './space-cleanup.port';

/**
 * Space deletion (docs/features/spaces.md section 5): erase everything a
 * space seals, through the ORDINARY deletion saga per source, then remove the
 * space's containers, then the space row itself.
 *
 * ## No second deletion mechanism
 *
 * Every source goes through the same `DeletionSaga` as a user's own delete:
 * the same cascades, the same all-or-nothing transaction per source, the same
 * signed receipt — ONE PER SOURCE, on the space's own chain, acting for each
 * source's own owner as the subject (the owner-erasure separation of subject
 * and actor). What is new is only WHO may invoke it (the administrative role,
 * because a space holds every user's material) and OVER WHAT SET (one
 * space).
 *
 * ## The structural completeness proof
 *
 * Every content-bearing table's `space_id` foreign key is NO ACTION, so the
 * final `DELETE FROM space` is REFUSED by Postgres while a single row
 * anywhere still names the space. "Nothing left behind in any store" is
 * therefore not a promise this service keeps by being careful; the Postgres
 * half is enforced by the schema, the vector and object halves by the same
 * per-source receipts and nightly sweep that cover every other deletion, and
 * the report/passport artifacts by the cleanup legs that return their object
 * keys for erasure here. The one deliberate exception is `deletion_receipt`
 * (its FK was dropped in 0061): a deleted space's receipts ARE the proof of
 * its erasure, are immutable, keep their per-space chain, and keep verifying
 * in the sweep, which walks chains from the receipts and never from the
 * space table.
 *
 * ## The default space is not deletable
 *
 * The record requires "not while it is the only space"; this service refuses
 * the default space ALWAYS, which subsumes that rule. The default space's
 * fixed id is the instance's resolution anchor: the schema-level DEFAULT,
 * the absent-header resolution, the email intake target and every CLI
 * principal all name it, so deleting it would leave every spaceless caller
 * pointing at nothing. Every other space is deletable, content and all.
 *
 * ## A plain, re-runnable worker pass
 *
 * The owner-erasure shape, for the same reasons: a space's corpus is
 * unbounded, one transaction per source keeps locks short, and a re-run
 * enumerates what is left and erases it. A source added to the space WHILE
 * the pass runs is caught by the final row delete refusing (its FK still
 * names the space), which fails the job loudly and the retry sweeps it up.
 */

export const SPACE_ERASE_JOB_TYPE = 'space.erase';

/** Idempotency/lock key namespace for the job above. */
export const SPACE_ERASE_SOURCE_TYPE = 'space_erasure';

/** What a deletion WOULD erase — the confirmation surface's numbers
 * (docs/features/spaces.md: the confirmation states exactly what will be
 * erased). Read-only and computed from listings alone. */
export type SpaceDeletionPlan = SpaceDeletionPlanDto;

/** What a pass DID. Failures stay in the space and the next run retries. */
export interface SpaceErasureResult {
  spaceId: string;
  erased: { sourceType: string; sourceId: string; receiptId: string | null }[];
  failed: { sourceType: string; sourceId: string; error: string }[];
  containersRemoved: Record<string, number>;
  spaceRowDeleted: boolean;
}

@Injectable()
export class SpaceErasureService {
  private readonly logger = new Logger(SpaceErasureService.name);
  private readonly adapters: SourceDeletion[];
  private readonly cleanups: SpaceCleanup[];

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly saga: DeletionSaga,
    private readonly objects: MemoryObjectStore,
    @Optional() @Inject(SOURCE_DELETIONS) adapters: SourceDeletion[] = [],
    @Optional() @Inject(SPACE_CLEANUPS) cleanups: SpaceCleanup[] = [],
  ) {
    this.adapters = adapters;
    this.cleanups = cleanups;
  }

  /** Refuses the two undeletable targets loudly; returns the row otherwise. */
  private async requireDeletable(spaceId: string): Promise<{ id: string; name: string }> {
    if (spaceId === DEFAULT_SPACE_ID) {
      throw untranslatedError.badRequest(
        'the default space cannot be deleted: it is the instance resolution anchor',
      );
    }
    const rows = await this.db
      .select({ id: space.id, name: space.name })
      .from(space)
      .where(eq(space.id, spaceId))
      .limit(1);
    if (!rows[0]) throw untranslatedError.notFound(`space ${spaceId} not found`);
    return rows[0];
  }

  async plan(spaceId: string): Promise<SpaceDeletionPlan> {
    const row = await this.requireDeletable(spaceId);
    const sources: { sourceType: string; count: number }[] = [];
    for (const adapter of this.adapters) {
      if (!adapter.listForSpace) continue;
      const refs = await adapter.listForSpace(this.db, spaceId);
      if (refs.length > 0) sources.push({ sourceType: adapter.sourceType, count: refs.length });
    }
    const files = await listAllFileSourcesForSpace(this.db, spaceId);
    if (files.length > 0) sources.push({ sourceType: 'file', count: files.length });
    const containers: { artifact: string; count: number }[] = [];
    for (const cleanup of this.cleanups) {
      const count = await cleanup.countForSpace(spaceId);
      if (count > 0) containers.push({ artifact: cleanup.artifact, count });
    }
    return {
      spaceId,
      name: row.name,
      sources,
      totalSources: sources.reduce((total, entry) => total + entry.count, 0),
      containers,
    };
  }

  /**
   * Records the request and enqueues the worker pass, transactionally, so a
   * deletion cannot be queued without a record of who asked for it. Returns
   * the plan, so the administrator sees the honest numbers at the moment
   * they asked.
   */
  async request(admin: Principal, spaceId: string): Promise<SpaceDeletionPlan> {
    const plan = await this.plan(spaceId);
    await this.db.transaction(async (tx) => {
      await withTransactionalEnqueue(
        tx,
        {
          type: 'space.deletion_requested',
          payload: { space_id: spaceId, requested_by: admin.userId },
        },
        {
          type: SPACE_ERASE_JOB_TYPE,
          payload: {
            source_type: SPACE_ERASE_SOURCE_TYPE,
            source_id: spaceId,
            // The administrator travels WITH the job (the owner-erasure
            // pattern): the pass runs in the worker, where there is no
            // Principal, and the trail must name who asked.
            actor: `user:${admin.userId}`,
            org_id: admin.orgId,
          },
          principalId: admin.userId,
        },
      );
      await writeAudit(tx, {
        actor: `user:${admin.userId}`,
        action: 'space.deletion_requested',
        entityType: 'space',
        entityId: spaceId,
        detail: {
          plannedSources: plan.totalSources,
          plannedContainers: plan.containers.reduce((total, entry) => total + entry.count, 0),
        },
        orgId: admin.orgId,
        spaceId,
      });
    });
    return plan;
  }

  /**
   * The pass itself (the worker's job body): sources through the ordinary
   * saga in enumeration order, then the container cleanups, then the space
   * row, whose delete succeeding IS the completeness verification.
   */
  async run(spaceId: string, actor: string, orgId: string): Promise<SpaceErasureResult> {
    const result: SpaceErasureResult = {
      spaceId,
      erased: [],
      failed: [],
      containersRemoved: {},
      spaceRowDeleted: false,
    };
    if (spaceId === DEFAULT_SPACE_ID) {
      throw untranslatedError.badRequest(
        'the default space cannot be deleted: it is the instance resolution anchor',
      );
    }
    const rows = await this.db
      .select({ id: space.id })
      .from(space)
      .where(eq(space.id, spaceId))
      .limit(1);
    if (!rows[0]) {
      // A retry after the row already went (the pass is re-runnable and the
      // delete is the last act): done is done, not an error.
      result.spaceRowDeleted = true;
      return result;
    }

    const sources: { sourceType: string; sourceId: string; ownerId: string }[] = [];
    for (const adapter of this.adapters) {
      if (!adapter.listForSpace) continue;
      for (const ref of await adapter.listForSpace(this.db, spaceId)) {
        sources.push({ sourceType: adapter.sourceType, ...ref });
      }
    }
    for (const ref of await listAllFileSourcesForSpace(this.db, spaceId)) {
      sources.push({ sourceType: 'file', ...ref });
    }

    for (const source of sources) {
      try {
        const outcome = await this.saga.eraseSpaceSource(
          { userId: source.ownerId, orgId },
          actor,
          source.sourceType,
          source.sourceId,
        );
        result.erased.push({
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          receiptId: outcome.receiptId,
        });
      } catch (error) {
        // A source that vanished between enumeration and its turn (a
        // concurrent deletion, a cascade that already took it) is ordinary;
        // anything else is retried by the next pass. Either way the final
        // row delete cannot succeed while material remains, so nothing is
        // ever silently left behind.
        result.failed.push({
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Container cleanups AFTER the sources: a report or passport row expired
    // by a source deletion above is then removed here with its object keys.
    for (const cleanup of this.cleanups) {
      const { count, objectKeys } = await cleanup.cleanupSpace(spaceId);
      result.containersRemoved[cleanup.artifact] = count;
      // Artifact bytes (report/passport exports) erased directly: they are
      // derived artifacts outside any source's receipt, their removal is
      // audited by the owning cleanup, and absent keys are success, which is
      // what makes the re-run safe.
      for (const key of objectKeys) await this.objects.deleteObject(key);
    }

    // The final act, and the proof: every content table's space FK is
    // NO ACTION, so this DELETE succeeds only when NOTHING anywhere still
    // names the space. A refusal here is a leftover found, and the job
    // retries rather than reporting a deletion that did not complete.
    // user_space_state cascades with the row, so a persisted last-used
    // pointer at this space resolves to the default space from now on.
    await this.db.delete(space).where(eq(space.id, spaceId));
    result.spaceRowDeleted = true;

    await writeAudit(this.db, {
      actor,
      action: 'space.deleted',
      entityType: 'space',
      entityId: spaceId,
      detail: {
        erased: result.erased.length,
        receipts: result.erased.filter((entry) => entry.receiptId !== null).length,
        failed: result.failed.length,
        ...result.containersRemoved,
      },
      orgId,
      spaceId,
    });
    this.logger.log(
      `space ${spaceId} deleted: ${result.erased.length} sources erased, ` +
        `${result.failed.length} failed, containers ${JSON.stringify(result.containersRemoved)}`,
    );
    return result;
  }
}
