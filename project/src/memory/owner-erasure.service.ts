import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SOURCE_TYPES } from '@cogeto/shared';
import type { MemoryScope, Principal } from '@cogeto/shared';
import {
  DRIZZLE,
  readAuditEntries,
  withTransactionalEnqueue,
  writeAudit,
} from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { DeletionSaga, SOURCE_DELETIONS } from './deletion-saga';
import type { RetentionReason, SourceDeletion } from './deletion-saga';
import { listAllFileSourcesForOwner } from './file-store';
import type { SourceType } from './persistence/tables';

/**
 * Owner erasure (issue #632): erasing a departed user's private material.
 *
 * ## Why this exists
 *
 * The deletion saga refuses any source the caller does not own, and there was
 * no administrative override. When someone leaves and their account is
 * deactivated, their private material becomes unreachable to every route in
 * the product: nobody can read it, and nobody can delete it. Fulfilling an
 * erasure request meant editing Postgres, Qdrant and MinIO by hand, which
 * produces no receipt, breaks nothing detectably, and quietly voids the
 * "forgetting is provable" claim for exactly the data someone asked to have
 * forgotten.
 *
 * ## What it is, and what it deliberately is not
 *
 * It is NOT a second deletion mechanism. Every source goes through the same
 * `DeletionSaga`, the same sixteen cascades, the same all-or-nothing
 * transaction, the same signed and chained receipt, and the same nightly
 * sweep. What is new is only WHO may invoke it (the administrative role) and
 * OVER WHAT SET (one subject's private sources). If this file were deleted
 * tomorrow, no guarantee in the product would change; only the reach would.
 *
 * ## The scope rule (fixed by the owner, not a design decision to revisit)
 *
 * **Private material owned by the subject is erased. Shared material always
 * stays, without exception.** A colleague's shared knowledge does not
 * disappear because that colleague left. Two checks implement it:
 *
 * 1. **Here**, over the source rows: a source whose own row records
 *    `scope: 'shared'` is never even attempted. Reason `shared_source`.
 * 2. **Inside the saga's transaction**, over the complete enumeration
 *    including cascade members: if any derived fact is shared, the whole
 *    source is retained and the transaction rolls back. Reason
 *    `shared_derived_fact`.
 *
 * The second check is the one that matters, and it is in the saga rather than
 * here because the saga is the only place that knows the full set a single
 * deletion would remove.
 *
 * ### The three boundary cases, and how each is resolved
 *
 * - **A source whose scope changed over its life.** The CURRENT scope decides.
 *   There is no scope history on a source row, so the present value is the
 *   only recorded truth — and it is the right one regardless: it is the scope
 *   under which the material is readable by colleagues today. A source made
 *   shared last week stays, even if it spent a year private; a source made
 *   private last week goes, even if it spent a year shared, because nobody can
 *   see it any more.
 *
 * - **A private source referenced by shared material.** Two sub-cases, and
 *   they resolve differently on purpose. If the shared material is a fact
 *   DERIVED FROM this source, check 2 retains the whole source: erasing it
 *   would take the shared fact with it, since the saga deletes by provenance.
 *   If the shared material merely POINTS AT something in this source — a
 *   surviving fact whose `superseded_by` referenced an erased row, an answer
 *   that cited it — the source is erased and the existing saga behaviour
 *   applies unchanged: the pointer is nulled and recorded in the receipt's
 *   `superseded_by_nulled`, the citing answer is redacted to a deletion
 *   marker. The shared CLAIM survives with its own provenance intact; only the
 *   link to erased material goes, which is what erasure means.
 *
 * - **Derived facts whose scope differs from their source.** This is check 2's
 *   entire reason for existing. Scope is stamped from the source at ingestion,
 *   but a user can re-scope one memory afterwards from the drawer, so a
 *   private source can hold a shared fact. Any shared fact retains the whole
 *   source.
 *
 * Where these were genuinely ambiguous the resolution preserves shared
 * material, as the rule requires. The cost is that a private source can be
 * kept because one fact derived from it is shared, which means a departed
 * user's private text survives inside a retained source. That is the honest
 * trade and it is reported, not hidden: every retention is returned with its
 * reason, audited, and printed by the operator procedure, so an administrator
 * who needs a retained source gone can delete it deliberately as its own act.
 *
 * ## The subject cannot authenticate, and nothing here assumes they can
 *
 * A subject is a stored `owner_id` string and nothing else. No identity
 * lookup, no session, no `Principal` from the identity provider: the whole
 * point of the feature is the state where the account is deactivated or gone
 * from Zitadel entirely. The org for audit stamping comes from the
 * ADMINISTRATOR, which on a single-tenant instance is the same org.
 *
 * ## The receipt shape: one per source
 *
 * An erasure spanning many sources produces one receipt per source, not one
 * covering the set. See {@link OWNER_ERASURE_JOB_TYPE} for the reasoning.
 */

/**
 * The worker job that runs an erasure (issue #632).
 *
 * **A job, not the request path.** The saga's enumeration transaction is
 * short, but an erasure runs one per source and a departed user's corpus is
 * unbounded. `AGENTS.md` puts deletion sagas in the worker, and holding an
 * HTTP request open across a whole corpus is what that rule is about.
 *
 * **A PLAIN, re-runnable pass** (the `import.advance` shape), deliberately NOT
 * `idempotentTask`: that wrapper runs its whole handler inside ONE
 * transaction, which would collapse the per-source all-or-nothing guarantee
 * into a single enormous transaction holding locks across the entire corpus,
 * where one failure would leave nothing erased.
 *
 * Re-running is the retry story and is safe by construction: a second pass
 * enumerates what is left, erases it, and retains what it retained before.
 * Two concurrent passes for the same subject are safe for the same reason the
 * ordinary saga is: it takes `FOR UPDATE` on each source row, so one wins each
 * source and the other reports its losses under `failed`. No outer lock is
 * taken, because an advisory lock held across the whole pass would be exactly
 * the long-held lock the per-source design exists to avoid.
 *
 * ## The receipt shape: ONE RECEIPT PER SOURCE
 *
 * The alternative — a single receipt covering the whole set — was considered
 * and rejected on three grounds, the first being the one that decides it.
 *
 * 1. **It is the shape a data subject can actually use.** A receipt is
 *    verifiable on its own: hash, signature, and a `counts_json` naming the
 *    exact identifiers erased. A set of per-source receipts can be handed to
 *    someone who checks each against the published public key with `jq` and
 *    `openssl`, and each one names what it removed. One aggregate receipt over
 *    hundreds of sources would be a single opaque blob that verifies as a
 *    whole or not at all: a subject could not check any individual claim in
 *    it, and a partial failure would leave the entire attestation `pending`,
 *    so an erasure that removed 99 of 100 sources would have no valid proof
 *    for any of them.
 *
 * 2. **It keeps the receipt unchanged**, which the brief required. The schema,
 *    the chain, `parseReceiptCounts` and the nightly sweep are all keyed to a
 *    single `(source_type, source_id)`. A set-receipt needs a new payload
 *    shape, which means a sweep that cannot re-derive what to verify absent
 *    from the receipts it already has.
 *
 * 3. **It keeps atomicity where it belongs.** One transaction per source is
 *    what makes each deletion all-or-nothing; one transaction per erasure
 *    would hold locks over an entire corpus.
 *
 * The set is not lost: `user.erasure_requested` and `user.erased` bracket the
 * run in the audit trail with the actor, the subject and the counts, so the
 * evidence a subject receives is one audited run plus N individually
 * verifiable receipts, each already linked into the instance's one chain.
 */
export const OWNER_ERASURE_JOB_TYPE = 'memory.erase_owner';

/** Idempotency/lock key namespace for the job above. */
export const OWNER_ERASURE_SOURCE_TYPE = 'user_erasure';

/** One source the plan found, before anything is erased. */
export interface PlannedSource {
  sourceType: SourceType;
  sourceId: string;
  scope: MemoryScope;
}

/**
 * What an erasure WOULD do — the administrator's confirmation numbers.
 * Read-only, and computed from source rows alone, so it is cheap and safe to
 * call repeatedly.
 *
 * `retainedShared` counts only what check 1 can see (shared SOURCES). Check 2
 * can retain more, because whether a private source holds a shared fact is a
 * question about the derived memories; the plan says so rather than promising
 * a number it cannot know without doing the enumeration.
 */
export interface OwnerErasurePlan {
  subjectUserId: string;
  /** Private sources the erasure will attempt, by type. */
  toErase: PlannedSource[];
  /** Shared sources, never attempted. */
  retainedShared: PlannedSource[];
}

/** What an erasure DID. Every source is in exactly one of the three lists. */
export interface OwnerErasureResult {
  subjectUserId: string;
  erased: { sourceType: SourceType; sourceId: string; receiptId: string | null }[];
  retained: { sourceType: SourceType; sourceId: string; reason: RetentionReason }[];
  failed: { sourceType: SourceType; sourceId: string; error: string }[];
}

@Injectable()
export class OwnerErasureService {
  private readonly logger = new Logger(OwnerErasureService.name);
  private readonly adapters: SourceDeletion[];

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly saga: DeletionSaga,
    @Optional() @Inject(SOURCE_DELETIONS) adapters: SourceDeletion[] = [],
  ) {
    this.adapters = adapters;
  }

  /**
   * Every source the subject owns, split by the scope on its row.
   *
   * Enumerated through each adapter's `listForOwner` plus `file_metadata`,
   * which memory owns directly. A source type whose adapter does not implement
   * the port contributes nothing — `chat` is the only such case today and it
   * is deliberate (its messages are cascade members of their conversation).
   */
  async plan(subjectUserId: string): Promise<OwnerErasurePlan> {
    const all: PlannedSource[] = [];

    for (const adapter of this.adapters) {
      if (!adapter.listForOwner) continue;
      const refs = await adapter.listForOwner(this.db, subjectUserId);
      for (const ref of refs) {
        all.push({ sourceType: adapter.sourceType, sourceId: ref.sourceId, scope: ref.scope });
      }
    }

    // `file` has no adapter: its source row IS file_metadata, memory's own.
    for (const ref of await listAllFileSourcesForOwner(this.db, subjectUserId)) {
      all.push({ sourceType: 'file', sourceId: ref.sourceId, scope: ref.scope });
    }

    return {
      subjectUserId,
      toErase: all.filter((source) => source.scope !== 'shared'),
      retainedShared: all.filter((source) => source.scope === 'shared'),
    };
  }

  /**
   * Records the request and enqueues the job. Returns the plan so the
   * administrator sees the honest numbers at the moment they asked, rather
   * than a bare acknowledgement.
   *
   * The audit entry names BOTH parties: `actor` is the administrator, and the
   * subject is on the entry as its owner and in the detail. It is written
   * transactionally with the enqueue, so an erasure cannot be queued without a
   * record of who asked for it.
   */
  async request(admin: Principal, subjectUserId: string): Promise<OwnerErasurePlan> {
    const plan = await this.plan(subjectUserId);
    await this.db.transaction(async (tx) => {
      await withTransactionalEnqueue(
        tx,
        {
          type: 'user.erasure_requested',
          payload: { subject_user_id: subjectUserId, requested_by: admin.userId },
        },
        {
          type: OWNER_ERASURE_JOB_TYPE,
          payload: {
            source_type: OWNER_ERASURE_SOURCE_TYPE,
            source_id: subjectUserId,
            // The administrator travels WITH the job: the pass runs in the
            // worker, where there is no Principal, and the trail must name who
            // asked rather than a faceless `deletion_saga`.
            actor: `user:${admin.userId}`,
            org_id: admin.orgId,
          },
          // Model spend attribution. Nothing here calls a model, but the
          // convention is that a job names whose work it is.
          principalId: subjectUserId,
        },
      );
      await writeAudit(tx, {
        actor: `user:${admin.userId}`,
        action: 'user.erasure_requested',
        entityType: 'user',
        entityId: subjectUserId,
        detail: {
          subject: subjectUserId,
          plannedErase: plan.toErase.length,
          retainedShared: plan.retainedShared.length,
        },
        orgId: admin.orgId,
        // The SUBJECT owns this entry: it is a record about their material.
        ownerId: subjectUserId,
      });
    });
    return plan;
  }

  /**
   * The counts of the most recent completed run for a subject, read back off
   * the `user.erased` audit entry the pass writes (issue #638).
   *
   * Read from the TRAIL rather than recounted, deliberately. A second count
   * taken now would answer a different question ("what is left") and would
   * drift from the record the moment anything else changed; the entry is what
   * the erasure actually did, and it is what an administrator would be shown
   * if they went looking in Audit. Null while no run has completed, which the
   * caller renders as still running.
   */
  async lastRun(subjectUserId: string): Promise<{
    erased: number;
    receipts: number;
    kept: number;
    keptForSharedFact: number;
    failed: number;
  } | null> {
    // Through infrastructure's public reader: `audit_log` is infrastructure's
    // table and a domain module never queries it directly (spec §15 rule 2).
    const rows = await readAuditEntries(this.db, {
      actions: ['user.erased'],
      entityType: 'user',
      entityIds: [subjectUserId],
      limit: 1,
    });
    const detail = rows[0]?.detail as Record<string, unknown> | undefined;
    if (!detail) return null;
    const n = (key: string): number => (typeof detail[key] === 'number' ? detail[key] : 0);
    return {
      erased: n('erased'),
      receipts: n('receipts'),
      kept: n('retained'),
      keptForSharedFact: n('retainedSharedFact'),
      failed: n('failed'),
    };
  }

  /**
   * The pass itself (the worker's job body). Runs one saga transaction per
   * source, in enumeration order, and never stops on a single failure: a
   * source that cannot be erased is reported and the rest still are, because
   * the alternative is one bad row blocking a legal obligation.
   *
   * `orgId` is the administrator's, carried on the job's audit entries. It is
   * read from the request entry rather than from the subject, who may no
   * longer exist in the identity provider.
   */
  async run(subjectUserId: string, actor: string, orgId: string): Promise<OwnerErasureResult> {
    const plan = await this.plan(subjectUserId);
    const subject = { userId: subjectUserId, orgId };
    const result: OwnerErasureResult = {
      subjectUserId,
      erased: [],
      retained: plan.retainedShared.map((source) => ({
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        reason: 'shared_source' as const,
      })),
      failed: [],
    };

    for (const source of plan.toErase) {
      try {
        const outcome = await this.saga.eraseOwnedSource(
          subject,
          actor,
          source.sourceType,
          source.sourceId,
        );
        if (outcome.retained) {
          result.retained.push({
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            reason: outcome.retained,
          });
        } else {
          result.erased.push({
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            receiptId: outcome.receiptId,
          });
        }
      } catch (error) {
        // A source that vanished between the plan and the pass (a concurrent
        // deletion, a cascade that already took it) is the ordinary case here
        // and is not a failure worth stopping for. It is still reported.
        result.failed.push({
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await writeAudit(this.db, {
      actor,
      action: 'user.erased',
      entityType: 'user',
      entityId: subjectUserId,
      detail: {
        subject: subjectUserId,
        erased: result.erased.length,
        receipts: result.erased.filter((e) => e.receiptId !== null).length,
        retained: result.retained.length,
        retainedSharedSource: result.retained.filter((r) => r.reason === 'shared_source').length,
        retainedSharedFact: result.retained.filter((r) => r.reason === 'shared_derived_fact')
          .length,
        failed: result.failed.length,
      },
      orgId,
      ownerId: subjectUserId,
    });
    this.logger.log(
      `owner erasure for ${subjectUserId}: ${result.erased.length} erased, ` +
        `${result.retained.length} retained (shared), ${result.failed.length} failed`,
    );
    return result;
  }
}

/**
 * The source types owner erasure can enumerate, for the boundary test that
 * keeps this honest: a new source type whose adapter forgets `listForOwner`
 * would be silently skipped by an erasure, which is the failure mode this
 * whole feature exists to remove.
 */
export function erasableSourceTypes(adapters: readonly SourceDeletion[]): SourceType[] {
  const fromAdapters = adapters
    .filter((adapter) => adapter.listForOwner !== undefined)
    .map((adapter) => adapter.sourceType);
  return ['file', ...fromAdapters];
}

/** Registered types that are neither defunct nor enumerable — must be empty. */
export function unerasableSourceTypes(adapters: readonly SourceDeletion[]): string[] {
  const covered = new Set<string>(erasableSourceTypes(adapters));
  return Object.entries(SOURCE_TYPES)
    .filter(([key, descriptor]) => !descriptor.defunct && !covered.has(key))
    .map(([key]) => key);
}
