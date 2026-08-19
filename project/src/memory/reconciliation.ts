import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { resolveSpaceId } from '@cogeto/shared';
import type {
  Principal,
  RelationDetector,
  RelationEvent,
  RelationResolution,
} from '@cogeto/shared';
import { DRIZZLE, userError, writeAudit } from '../infrastructure/index';
import { UserDirectory } from '../identity/index';
import type { Db, Tx } from '../infrastructure/index';
import { memory, memoryRelation, memoryRelationEvent } from './persistence/tables';
import type {
  MemoryRelationEventRow,
  MemoryRelationRow,
  MemoryRow,
  SourceType,
} from './persistence/tables';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryStore } from './memory.store';
import { actorLabel } from './domain/transition';
import type { MemoryActor } from './domain/transition';
import {
  chooseSurvivor,
  confirmLoserOutcome,
  eventTime,
  supersessionUnambiguous,
} from './domain/reconcile-policy';
import type { PolicyParty } from './domain/reconcile-policy';

/**
 * The Memory aggregate's reconciliation actions: the acting
 * half behind the pure policy in domain/reconcile-policy.ts. The ingestion
 * reconciliation service decides WHICH pairs to check and what the model
 * ruled; every state change lands here, so the invariants stay aggregate-owned
 * (spec §15 rule 4)
 *
 * - merges and reconciliation supersessions close intervals and point
 *   `superseded_by` — history is never destroyed (spec §6);
 * - only reconciliation sets `contradicted`, recording prior statuses in the
 *   relation row for dismiss-restoration;
 * - a `user_approved` memory is never touched except to pair it into a
 *   contradiction (0010 ruling 5);
 * - everything is idempotent under re-delivery: the canonical-pair unique
 *   index tombstones relations, `replaced` losers leave every candidate pool,
 *   and each action re-checks state under row locks and no-ops when already
 *   applied (0010 ruling 7).
 *
 * All mutating pair actions take the caller's `tx`: pipeline stage 6 runs
 * inside its job's idempotency transaction, where the incoming fact rows are
 * not yet committed and visible only through that transaction.
 */

export type PairActionResult =
  | { action: 'merged'; survivorId: string; loserId: string; enriched: boolean }
  | { action: 'contradiction_created'; relationId: string }
  | {
      /** An earlier finding on the pair's ancestors came back (V2.3 item 6.1):
       * reopened with its history rather than minted as new. */
      action: 'contradiction_reopened';
      relationId: string;
    }
  | { action: 'superseded'; winnerId: string; loserId: string }
  | { action: 'skipped'; reason: string };

/** What settling a finding after a party's supersession concluded. */
export type FindingSettlement =
  | { outcome: 'resolved_by_revision'; relationId: string }
  | { outcome: 'follows_successor'; relationId: string }
  | { outcome: 'kept_open'; relationId: string; reason: string };

export type ContradictionResolveAction =
  | { type: 'confirm'; winner: 'a' | 'b' }
  | { type: 'correct'; aContent: string; bContent: string }
  | { type: 'dismiss' };

export interface OpenContradiction {
  relation: MemoryRelationRow;
  a: MemoryRow;
  b: MemoryRow;
}

const RECONCILER: MemoryActor = { kind: 'reconciliation' };

function asParty(row: MemoryRow): PolicyParty {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
  };
}

const normalize = (text: string | null): string => (text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Restores one party of a dismissed/lifted contradiction to its recorded
 * prior status. Deliberately NOT via checkTransition: restoration targets
 * whatever status the detection recorded (uncertain included, which no actor
 * may set through the general matrix) — the second sanctioned bypass after
 * supersession, legal ONLY from `contradicted` and ONLY to the recorded
 * prior status. Exported for the deletion saga (0010 ruling 8).
 */
export async function restoreFromContradiction(
  tx: Tx,
  row: MemoryRow,
  priorStatus: MemoryRow['status'],
  auditAction: 'memory.contradiction_dismiss_restored' | 'memory.contradiction_lifted',
  actor: string,
  vectors?: MemoryVectorStore,
  orgId?: string,
): Promise<void> {
  if (row.status !== 'contradicted' || priorStatus === 'contradicted') return;
  await tx
    .update(memory)
    .set({ status: priorStatus, updatedAt: new Date() })
    .where(eq(memory.id, row.id));
  await writeAudit(tx, {
    actor,
    action: auditAction,
    entityType: 'memory',
    entityId: row.id,
    detail: { from: 'contradicted', to: priorStatus },
    ownerId: row.ownerId,
    orgId,
    spaceId: row.spaceId,
  });
  await vectors?.setPayload(row.id, { status: priorStatus });
}

/**
 * Deletion-saga hook (0010 ruling 8), called inside the enumeration
 * transaction BEFORE the memory rows are deleted: every unresolved relation
 * touching a doomed row has its surviving partner restored to the recorded
 * prior status — an accusation whose evidence is being erased does not stick.
 * The relation rows themselves go with the deleted memories (FK CASCADE).
 */
export async function liftContradictionsBeforeDeletion(
  tx: Tx,
  memoryIds: string[],
  vectors?: MemoryVectorStore,
  orgId?: string,
): Promise<number> {
  if (memoryIds.length === 0) return 0;
  const doomed = new Set(memoryIds);
  const relations = await tx
    .select()
    .from(memoryRelation)
    .where(
      and(
        isNull(memoryRelation.resolvedAt),
        or(
          inArray(memoryRelation.aMemoryId, memoryIds),
          inArray(memoryRelation.bMemoryId, memoryIds),
        ),
      ),
    )
    .for('update');
  let lifted = 0;
  for (const relation of relations) {
    const partnerSide = doomed.has(relation.aMemoryId)
      ? doomed.has(relation.bMemoryId)
        ? null // both parties are being deleted; nothing survives to restore
        : ('b' as const)
      : ('a' as const);
    if (!partnerSide) continue;
    const partnerId = partnerSide === 'a' ? relation.aMemoryId : relation.bMemoryId;
    const prior = partnerSide === 'a' ? relation.aPriorStatus : relation.bPriorStatus;
    const rows = await tx.select().from(memory).where(eq(memory.id, partnerId)).for('update');
    const partner = rows[0];
    if (!partner) continue;
    await restoreFromContradiction(
      tx,
      partner,
      prior,
      'memory.contradiction_lifted',
      'deletion_saga',
      vectors,
      orgId,
    );
    lifted += 1;
  }
  return lifted;
}

@Injectable()
export class MemoryReconciliation {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly store: MemoryStore,
    /** Optional so pure-Postgres tests need no Qdrant; DI always provides it. */
    @Optional() private readonly vectors?: MemoryVectorStore,
    /** Org resolution for audit stamping; DI provides it. */
    @Optional() private readonly directory?: UserDirectory,
  ) {}

  /** Org for audit stamping: the owner's org via the directory, else null. */
  private async orgFor(ownerId: string): Promise<string | undefined> {
    return (await this.directory?.orgOf(ownerId)) ?? undefined;
  }

  // ── Pair actions (stage 6 / dreaming; caller's transaction) ────────────────

  /**
   * `same_fact` merge (0010 ruling 4). `incoming` is the newly admitted fact,
   * `existing` the committed candidate. Survivor selection and the
   * user_approved shield live in chooseSurvivor; enrichment supersedes the
   * survivor only when the model composed genuinely changed content and the
   * survivor is not user_approved.
   */
  async mergeSameFact(
    tx: Tx,
    incomingId: string,
    existingId: string,
    mergedContent: string | null,
    // Advisory only — never persisted.
    _reason: string,
  ): Promise<PairActionResult> {
    const [first, second] = await this.lockPair(tx, incomingId, existingId);
    const incoming = first.id === incomingId ? first : second;
    const existing = first.id === existingId ? first : second;
    if (incoming.status === 'replaced' || existing.status === 'replaced') {
      return { action: 'skipped', reason: 'a party is already replaced (merge already applied?)' };
    }
    if (incoming.supersededBy === existingId || existing.supersededBy === incomingId) {
      return { action: 'skipped', reason: 'pair already merged' };
    }
    const decision = chooseSurvivor(asParty(incoming), asParty(existing));
    if (decision.action === 'none') {
      return { action: 'skipped', reason: decision.reason };
    }
    const survivorRow = decision.survivor.id === incoming.id ? incoming : existing;
    const loserRow = decision.loser.id === incoming.id ? incoming : existing;

    // Enrichment (0010 ruling 4): only real content change, never a
    // user_approved survivor. The enriched successor inherits the survivor's
    // provenance and status; entities are the union of both parties.
    let finalSurvivor = survivorRow;
    let enriched = false;
    const enrichedContent = normalize(mergedContent);
    if (
      enrichedContent &&
      survivorRow.status !== 'user_approved' &&
      enrichedContent !== normalize(survivorRow.content) &&
      (survivorRow.status === 'active' || survivorRow.status === 'uncertain')
    ) {
      const { successor } = await this.store.supersedeInTx(tx, RECONCILER, survivorRow.id, {
        content: enrichedContent,
        scope: survivorRow.scope,
        sourceType: survivorRow.sourceType,
        sourceId: survivorRow.sourceId,
        entities: [...new Set([...survivorRow.entities, ...loserRow.entities])],
        subjectEntity: survivorRow.subjectEntity ?? loserRow.subjectEntity ?? undefined,
        kind: survivorRow.kind ?? loserRow.kind ?? undefined,
        sensitive: survivorRow.sensitive,
        validFrom: survivorRow.validFrom ?? undefined,
        validUntil: survivorRow.validUntil ?? undefined,
        // The survivor's authorship carries to its enriched successor: an
        // enrichment adds a detail, it does not change whose words these were.
        authoredByUser: survivorRow.authoredByUser ?? undefined,
        initialStatus: survivorRow.status,
      });
      finalSurvivor = successor;
      enriched = true;
    }

    // The model's merge rationale is NOT persisted
    // audit detail is structural metadata only, and a merge needs no durable
    // explanation beyond the supersession pointer itself.
    await this.closeAndPoint(tx, loserRow, finalSurvivor, 'memory.merged', {
      survivor: finalSurvivor.id,
      enriched,
    });
    return { action: 'merged', survivorId: finalSurvivor.id, loserId: loserRow.id, enriched };
  }

  /**
   * `contradicts` pairing (0010 ruling 2): insert the relation (canonical-pair
   * unique index makes re-detection a no-op), record prior statuses, and
   * transition both parties to `contradicted` — the one legal touch of a
   * user_approved memory (ruling 5).
   *
   * V2.3 item 6.1: before minting a new finding, detection walks both
   * parties' supersession ancestry. A finding that already tracked this
   * conflict on earlier revisions of the same facts REOPENS (resolved) or
   * FOLLOWS the successors (still open), with its history intact — a corpus
   * that regresses shows that it regressed, not a fresh discovery.
   */
  async createContradiction(
    tx: Tx,
    incomingId: string,
    existingId: string,
    reason: string,
    detectedBy: RelationDetector = 'pipeline',
  ): Promise<PairActionResult> {
    const [first, second] = await this.lockPair(tx, incomingId, existingId);
    const incoming = first.id === incomingId ? first : second;
    const existing = first.id === existingId ? first : second;
    if (incoming.status === 'replaced' || existing.status === 'replaced') {
      return { action: 'skipped', reason: 'a party is already replaced' };
    }

    // The exact pair's tombstone wins over everything, ancestry included:
    // resolved or not, this pair was already ruled on, and re-pointing an
    // ancestral finding onto it would collide with the canonical-pair index.
    if (await this.exactRelation(tx, incoming.id, existing.id)) {
      return { action: 'skipped', reason: 'relation already exists for this pair (tombstone)' };
    }

    const ancestral = await this.ancestralRelation(tx, incoming.id, existing.id);
    if (ancestral) {
      if (!ancestral.resolvedAt) {
        // Still open on predecessor rows (an edit-supersession moved a party
        // under it): the finding follows the successors; no second finding.
        await this.repointParties(tx, ancestral, incoming, existing, reason);
        await this.relationEvent(tx, ancestral.id, 'party_superseded', {
          a: incoming.id,
          b: existing.id,
          detected_by: detectedBy,
        });
        return { action: 'skipped', reason: 'open finding followed the pair onto its successors' };
      }
      const reopened = await this.repointParties(tx, ancestral, incoming, existing, reason, {
        clearResolution: true,
      });
      await this.relationEvent(tx, ancestral.id, 'reopened', {
        a: incoming.id,
        b: existing.id,
        undoes: ancestral.resolution,
        detected_by: detectedBy,
      });
      await writeAudit(tx, {
        actor: actorLabel(RECONCILER),
        action: 'memory.contradiction_reopened',
        entityType: 'memory_relation',
        entityId: ancestral.id,
        detail: { a: incoming.id, b: existing.id, undoes: ancestral.resolution },
        ownerId: incoming.ownerId,
        orgId: await this.orgFor(incoming.ownerId),
        spaceId: incoming.spaceId,
      });
      return { action: 'contradiction_reopened', relationId: reopened.id };
    }

    const inserted = await tx
      .insert(memoryRelation)
      .values({
        kind: 'contradicts',
        aMemoryId: incoming.id,
        bMemoryId: existing.id,
        aPriorStatus: incoming.status,
        bPriorStatus: existing.status,
        // The model's explanation lives HERE — the owner-gated relation row the
        // Review queue reads — never in the org-readable audit trail (
        //). Erased with the relation (FK CASCADE with the pair).
        reason,
        detectedBy,
      })
      .onConflictDoNothing()
      .returning();
    const relation = inserted[0];
    if (!relation) {
      return { action: 'skipped', reason: 'relation already exists for this pair (tombstone)' };
    }
    for (const row of [incoming, existing]) {
      if (row.status !== 'contradicted') {
        await this.store.transitionInTx(tx, RECONCILER, row.id, 'contradicted', reason);
      }
    }
    await this.relationEvent(tx, relation.id, 'detected', {
      a: incoming.id,
      b: existing.id,
      detected_by: detectedBy,
    });
    await writeAudit(tx, {
      actor: actorLabel(RECONCILER),
      action: 'memory.contradiction_detected',
      entityType: 'memory_relation',
      entityId: relation.id,
      detail: { a: incoming.id, b: existing.id, detectedBy },
      ownerId: incoming.ownerId,
      orgId: await this.orgFor(incoming.ownerId),
      spaceId: incoming.spaceId,
    });
    return { action: 'contradiction_created', relationId: relation.id };
  }

  // ── Findings lifecycle (V2.3 item 6.1; docs/features/findings.md) ──────────

  /** Open findings a memory is party to, locked for the caller's settlement. */
  async openRelationsTouching(tx: Tx, memoryId: string): Promise<MemoryRelationRow[]> {
    return tx
      .select()
      .from(memoryRelation)
      .where(
        and(
          isNull(memoryRelation.resolvedAt),
          eq(memoryRelation.kind, 'contradicts'),
          or(eq(memoryRelation.aMemoryId, memoryId), eq(memoryRelation.bMemoryId, memoryId)),
        ),
      )
      .for('update');
  }

  /**
   * The conflict is genuinely gone: the finding resolves as `revision`, the
   * surviving counterpart is restored to its recorded prior status, and the
   * event names the cause — the superseded party, its successor, and the
   * source revision link where the caller found one. Conservative by
   * construction: the CALLER established compatibility first.
   */
  async resolveByRevision(
    tx: Tx,
    relation: MemoryRelationRow,
    cause: {
      supersededId: string;
      successorId: string;
      sourceRevisionId?: string | null;
    },
  ): Promise<FindingSettlement> {
    const counterpartSide = relation.aMemoryId === cause.supersededId ? 'b' : 'a';
    const counterpartId = counterpartSide === 'a' ? relation.aMemoryId : relation.bMemoryId;
    const prior = counterpartSide === 'a' ? relation.aPriorStatus : relation.bPriorStatus;
    const rows = await tx.select().from(memory).where(eq(memory.id, counterpartId)).for('update');
    const counterpart = rows[0];
    if (counterpart) {
      await restoreFromContradiction(
        tx,
        counterpart,
        prior,
        'memory.contradiction_lifted',
        actorLabel(RECONCILER),
        this.vectors,
        await this.orgFor(counterpart.ownerId),
      );
    }
    await tx
      .update(memoryRelation)
      .set({ resolvedAt: new Date(), resolution: 'revision' })
      .where(eq(memoryRelation.id, relation.id));
    await this.relationEvent(tx, relation.id, 'resolved_by_revision', {
      superseded: cause.supersededId,
      successor: cause.successorId,
      source_revision: cause.sourceRevisionId ?? null,
    });
    if (counterpart) {
      await writeAudit(tx, {
        actor: actorLabel(RECONCILER),
        action: 'memory.contradiction_resolved',
        entityType: 'memory_relation',
        entityId: relation.id,
        detail: { resolution: 'revision', superseded: cause.supersededId },
        ownerId: counterpart.ownerId,
        orgId: await this.orgFor(counterpart.ownerId),
        spaceId: counterpart.spaceId,
      });
    }
    return { outcome: 'resolved_by_revision', relationId: relation.id };
  }

  /**
   * The conflict persists against the successor: same finding, new party.
   * The successor takes the superseded party's side (transitioned to
   * `contradicted`, its prior status recorded), and the event log says so.
   */
  async followSuccessor(
    tx: Tx,
    relation: MemoryRelationRow,
    supersededId: string,
    successorId: string,
  ): Promise<FindingSettlement> {
    const [firstRow, secondRow] = await this.lockPair(
      tx,
      successorId,
      relation.aMemoryId === supersededId ? relation.bMemoryId : relation.aMemoryId,
    );
    const successor = firstRow.id === successorId ? firstRow : secondRow;
    const side = relation.aMemoryId === supersededId ? 'a' : 'b';
    const duplicate = await this.exactRelation(
      tx,
      successorId,
      side === 'a' ? relation.bMemoryId : relation.aMemoryId,
    );
    if (duplicate) {
      // A finding for the successor pair already exists; folding two rows
      // into one would erase a history. Resolve this one toward it.
      await tx
        .update(memoryRelation)
        .set({ resolvedAt: new Date(), resolution: 'revision' })
        .where(eq(memoryRelation.id, relation.id));
      await this.relationEvent(tx, relation.id, 'resolved_by_revision', {
        superseded: supersededId,
        successor: successorId,
        merged_into: duplicate.id,
      });
      return { outcome: 'resolved_by_revision', relationId: relation.id };
    }
    await tx
      .update(memoryRelation)
      .set(
        side === 'a'
          ? { aMemoryId: successorId, aPriorStatus: successor.status }
          : { bMemoryId: successorId, bPriorStatus: successor.status },
      )
      .where(eq(memoryRelation.id, relation.id));
    if (successor.status !== 'contradicted') {
      await this.store.transitionInTx(
        tx,
        RECONCILER,
        successorId,
        'contradicted',
        'finding follows the successor of a superseded party',
      );
    }
    await this.relationEvent(tx, relation.id, 'party_superseded', {
      from: supersededId,
      to: successorId,
      side,
    });
    return { outcome: 'follows_successor', relationId: relation.id };
  }

  /**
   * Ambiguity: the finding stays open and the event log records why it was
   * not closed — a findings report that clears items it should not is worse
   * than one that clears too few.
   */
  async keepOpen(tx: Tx, relation: MemoryRelationRow, reason: string): Promise<FindingSettlement> {
    await this.relationEvent(tx, relation.id, 'kept_open', { reason });
    return { outcome: 'kept_open', relationId: relation.id, reason };
  }

  /** The finding's history, oldest first (owner-gated through the relation). */
  async eventsForRelations(
    principal: Principal,
    relationIds: string[],
  ): Promise<Map<string, MemoryRelationEventRow[]>> {
    const out = new Map<string, MemoryRelationEventRow[]>();
    if (relationIds.length === 0) return out;
    const a = alias(memory, 'relation_a');
    const b = alias(memory, 'relation_b');
    const rows = await this.db
      .select({ event: memoryRelationEvent })
      .from(memoryRelationEvent)
      .innerJoin(memoryRelation, eq(memoryRelationEvent.relationId, memoryRelation.id))
      .innerJoin(a, eq(memoryRelation.aMemoryId, a.id))
      .innerJoin(b, eq(memoryRelation.bMemoryId, b.id))
      .where(
        and(
          inArray(memoryRelationEvent.relationId, relationIds),
          eq(a.ownerId, principal.userId),
          eq(b.ownerId, principal.userId),
        ),
      )
      .orderBy(asc(memoryRelationEvent.createdAt), memoryRelationEvent.id);
    for (const { event } of rows) {
      out.set(event.relationId, [...(out.get(event.relationId) ?? []), event]);
    }
    return out;
  }

  /**
   * `supersedes` verdict (0010 ruling 7): spec §6 mechanics against the existing
   * winner — interval closed, loser `replaced`, pointer set. The caller ran
   * the direction guard; this re-checks it defensively and skips rather than
   * ever superseding ambiguously.
   */
  async applySupersession(
    tx: Tx,
    winnerId: string,
    loserId: string,
    // Advisory only — never persisted.
    _reason: string,
  ): Promise<PairActionResult> {
    const [first, second] = await this.lockPair(tx, winnerId, loserId);
    const winner = first.id === winnerId ? first : second;
    const loser = first.id === loserId ? first : second;
    if (winner.status === 'replaced' || loser.status === 'replaced') {
      return { action: 'skipped', reason: 'a party is already replaced' };
    }
    if (!supersessionUnambiguous(asParty(winner), asParty(loser))) {
      return { action: 'skipped', reason: 'direction ambiguous or a party is user_approved' };
    }
    await this.closeAndPoint(tx, loser, winner, 'memory.superseded', {
      supersededBy: winner.id,
      mechanism: 'reconciliation',
    });
    return { action: 'superseded', winnerId: winner.id, loserId: loser.id };
  }

  // ── The contradicted queue (Review surface) ────────────────────────────────

  /** Open contradictions where BOTH parties belong to the caller, newest first. */
  async listOpenContradictions(principal: Principal): Promise<OpenContradiction[]> {
    const a = alias(memory, 'relation_a');
    const b = alias(memory, 'relation_b');
    const rows = await this.db
      .select({ relation: memoryRelation, a, b })
      .from(memoryRelation)
      .innerJoin(a, eq(memoryRelation.aMemoryId, a.id))
      .innerJoin(b, eq(memoryRelation.bMemoryId, b.id))
      .where(
        and(
          isNull(memoryRelation.resolvedAt),
          eq(memoryRelation.kind, 'contradicts'),
          eq(a.ownerId, principal.userId),
          eq(b.ownerId, principal.userId),
          // Both parties live in one space by construction (pairing is
          // space-scoped); the caller sees only their current space's queue.
          eq(a.spaceId, resolveSpaceId(principal)),
          eq(b.spaceId, resolveSpaceId(principal)),
        ),
      )
      .orderBy(desc(memoryRelation.detectedAt), memoryRelation.id);
    return rows.map((row) => ({ relation: row.relation, a: row.a, b: row.b }));
  }

  async countOpenContradictions(principal: Principal): Promise<number> {
    return (await this.listOpenContradictions(principal)).length;
  }

  /**
   * Open contradictions ONE source's facts are party to (V2.2 item 5.1): the
   * honest number behind "added to sources: 47 facts, 1 contradiction". Same
   * owner gate as the queue above; a relation counts when either side is a
   * memory derived from the given source.
   */
  async countOpenContradictionsForSource(
    principal: Principal,
    sourceType: SourceType,
    sourceId: string,
  ): Promise<number> {
    const a = alias(memory, 'relation_a');
    const b = alias(memory, 'relation_b');
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memoryRelation)
      .innerJoin(a, eq(memoryRelation.aMemoryId, a.id))
      .innerJoin(b, eq(memoryRelation.bMemoryId, b.id))
      .where(
        and(
          isNull(memoryRelation.resolvedAt),
          eq(memoryRelation.kind, 'contradicts'),
          eq(a.ownerId, principal.userId),
          eq(b.ownerId, principal.userId),
          eq(a.spaceId, resolveSpaceId(principal)),
          eq(b.spaceId, resolveSpaceId(principal)),
          or(
            and(eq(a.sourceType, sourceType), eq(a.sourceId, sourceId)),
            and(eq(b.sourceType, sourceType), eq(b.sourceId, sourceId)),
          ),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  /**
   * Open-contradiction counts for ONE page of catalog refs (V2.2 item 5.2):
   * one grouped query over both sides of the relation join, never a query per
   * row. A relation counts for every source it touches.
   */
  async openContradictionCountsForSources(
    principal: Principal,
    refs: readonly { sourceType: string; sourceId: string }[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (refs.length === 0) return out;
    const a = alias(memory, 'relation_a');
    const b = alias(memory, 'relation_b');
    const pairs = refs.map((ref) => sql`(${ref.sourceType}, ${ref.sourceId})`);
    const inPage = (side: typeof a | typeof b) =>
      sql`(${side.sourceType}, ${side.sourceId}) IN (${sql.join(pairs, sql`, `)})`;
    const rows = await this.db
      .select({
        aType: a.sourceType,
        aId: a.sourceId,
        bType: b.sourceType,
        bId: b.sourceId,
      })
      .from(memoryRelation)
      .innerJoin(a, eq(memoryRelation.aMemoryId, a.id))
      .innerJoin(b, eq(memoryRelation.bMemoryId, b.id))
      .where(
        and(
          isNull(memoryRelation.resolvedAt),
          eq(memoryRelation.kind, 'contradicts'),
          eq(a.ownerId, principal.userId),
          eq(b.ownerId, principal.userId),
          eq(a.spaceId, resolveSpaceId(principal)),
          eq(b.spaceId, resolveSpaceId(principal)),
          or(inPage(a), inPage(b)),
        ),
      );
    const bump = (type: string, id: string) => {
      const key = `${type} ${id}`;
      out.set(key, (out.get(key) ?? 0) + 1);
    };
    for (const row of rows) {
      bump(row.aType, row.aId);
      // A relation inside one source counts once for it, not twice.
      if (row.aType !== row.bType || row.aId !== row.bId) bump(row.bType, row.bId);
    }
    return out;
  }

  /**
   * The refs of sources party to at least one OPEN contradiction (V2.2 item
   * 5.2): the driving query behind "every document with a contradiction".
   */
  async sourceRefsWithOpenContradictions(
    principal: Principal,
  ): Promise<{ sourceType: string; sourceId: string }[]> {
    const open = await this.listOpenContradictions(principal);
    const seen = new Map<string, { sourceType: string; sourceId: string }>();
    for (const { a, b } of open) {
      seen.set(`${a.sourceType} ${a.sourceId}`, { sourceType: a.sourceType, sourceId: a.sourceId });
      seen.set(`${b.sourceType} ${b.sourceId}`, { sourceType: b.sourceType, sourceId: b.sourceId });
    }
    return [...seen.values()];
  }

  /**
   * The contradictions ONE source's facts are party to (V2.2 item 5.2, the
   * source detail view): open first, then resolved with their resolution, so
   * the surface can show the finding in context and the report (V2.3) can
   * state detection date and resolution status. Same owner gate as the queue.
   */
  async contradictionsForSource(
    principal: Principal,
    sourceType: string,
    sourceId: string,
    options: { includeResolved?: boolean } = {},
  ): Promise<OpenContradiction[]> {
    const a = alias(memory, 'relation_a');
    const b = alias(memory, 'relation_b');
    const touches = (side: typeof a | typeof b) =>
      and(eq(side.sourceType, sql`${sourceType}`), eq(side.sourceId, sourceId));
    const rows = await this.db
      .select({ relation: memoryRelation, a, b })
      .from(memoryRelation)
      .innerJoin(a, eq(memoryRelation.aMemoryId, a.id))
      .innerJoin(b, eq(memoryRelation.bMemoryId, b.id))
      .where(
        and(
          eq(memoryRelation.kind, 'contradicts'),
          eq(a.ownerId, principal.userId),
          eq(b.ownerId, principal.userId),
          eq(a.spaceId, resolveSpaceId(principal)),
          eq(b.spaceId, resolveSpaceId(principal)),
          options.includeResolved ? undefined : isNull(memoryRelation.resolvedAt),
          or(touches(a), touches(b)),
        ),
      )
      .orderBy(
        sql`${memoryRelation.resolvedAt} IS NOT NULL`,
        desc(memoryRelation.detectedAt),
        memoryRelation.id,
      );
    return rows.map((row) => ({ relation: row.relation, a: row.a, b: row.b }));
  }

  /**
   * Every contradiction relation ONE memory is party to, resolved included
   * (V2.2 item 5.2, the fact detail view). The counterpart rides along; the
   * owner gate is the queue's.
   */
  async relationsForMemory(
    principal: Principal,
    memoryId: string,
  ): Promise<{ relation: MemoryRelationRow; other: MemoryRow }[]> {
    const a = alias(memory, 'relation_a');
    const b = alias(memory, 'relation_b');
    const rows = await this.db
      .select({ relation: memoryRelation, a, b })
      .from(memoryRelation)
      .innerJoin(a, eq(memoryRelation.aMemoryId, a.id))
      .innerJoin(b, eq(memoryRelation.bMemoryId, b.id))
      .where(
        and(
          eq(memoryRelation.kind, 'contradicts'),
          eq(a.ownerId, principal.userId),
          eq(b.ownerId, principal.userId),
          eq(a.spaceId, resolveSpaceId(principal)),
          eq(b.spaceId, resolveSpaceId(principal)),
          or(eq(memoryRelation.aMemoryId, memoryId), eq(memoryRelation.bMemoryId, memoryId)),
        ),
      )
      .orderBy(desc(memoryRelation.detectedAt), memoryRelation.id);
    return rows.map((row) => ({
      relation: row.relation,
      other: row.relation.aMemoryId === memoryId ? row.b : row.a,
    }));
  }

  /**
   * Owner resolution of a contradiction (0010 ruling 3). One transaction
   * status outcomes per the ruling, the relation resolved, every touched
   * entity audited. Resolving an already-resolved relation is a no-op (the
   * queue refetches), not an error.
   */
  async resolveContradiction(
    principal: Principal,
    relationId: string,
    action: ContradictionResolveAction,
  ): Promise<{ relation: MemoryRelationRow; alreadyResolved: boolean }> {
    return this.db.transaction(async (tx) => {
      const relations = await tx
        .select()
        .from(memoryRelation)
        .where(eq(memoryRelation.id, relationId))
        .for('update');
      const relation = relations[0];
      if (!relation)
        throw userError.notFound('relation.notFound', 'relation {{id}} not found', {
          id: relationId,
        });
      if (relation.resolvedAt) return { relation, alreadyResolved: true };

      const [first, second] = await this.lockPair(tx, relation.aMemoryId, relation.bMemoryId);
      const rowA = first.id === relation.aMemoryId ? first : second;
      const rowB = first.id === relation.bMemoryId ? first : second;
      if (rowA.ownerId !== principal.userId || rowB.ownerId !== principal.userId) {
        // Existence must not leak — mirror of the store's owner checks.
        throw userError.notFound('relation.notFound', 'relation {{id}} not found', {
          id: relationId,
        });
      }
      const user: MemoryActor = { kind: 'user', userId: principal.userId };

      // The three resolution outcomes (0010 ruling 3), each extracted to a
      // behavior-preserving helper: confirm one party (loser outdated or
      // superseded), correct both by edit-as-supersession, or dismiss (restore
      // both to their prior status). Every helper runs inside `tx`.
      let resolution: RelationResolution;
      if (action.type === 'confirm') {
        resolution = await this.applyConfirm(tx, user, rowA, rowB, action.winner);
      } else if (action.type === 'correct') {
        resolution = await this.applyCorrect(tx, principal, rowA, rowB, action);
      } else {
        resolution = await this.applyDismiss(tx, user, principal, rowA, rowB, relation);
      }

      const [resolved] = await tx
        .update(memoryRelation)
        .set({ resolvedAt: new Date(), resolution })
        .where(eq(memoryRelation.id, relation.id))
        .returning();
      // Both resolution paths are uniform for reporting (V2.3 item 6.1):
      // the user's action lands in the same event log the revision path uses.
      await this.relationEvent(tx, relation.id, 'resolved_by_user', { resolution });
      await writeAudit(tx, {
        actor: actorLabel(user),
        action: 'memory.contradiction_resolved',
        entityType: 'memory_relation',
        entityId: relation.id,
        detail: { resolution, a: rowA.id, b: rowB.id },
        ownerId: principal.userId,
        orgId: principal.orgId,
        spaceId: rowA.spaceId,
      });
      return { relation: resolved as MemoryRelationRow, alreadyResolved: false };
    });
  }

  // ── Private mechanics ───────────────────────────────────────────────────────

  /** Append one lifecycle event (docs/features/findings.md). Structural ids only. */
  private async relationEvent(
    tx: Tx,
    relationId: string,
    event: RelationEvent,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(memoryRelationEvent).values({ relationId, event, detailJson: detail });
  }

  /** The relation for exactly this pair, either order, if one exists. */
  private async exactRelation(
    tx: Tx,
    oneId: string,
    otherId: string,
  ): Promise<MemoryRelationRow | null> {
    const rows = await tx
      .select()
      .from(memoryRelation)
      .where(
        and(
          eq(memoryRelation.kind, 'contradicts'),
          or(
            and(eq(memoryRelation.aMemoryId, oneId), eq(memoryRelation.bMemoryId, otherId)),
            and(eq(memoryRelation.aMemoryId, otherId), eq(memoryRelation.bMemoryId, oneId)),
          ),
        ),
      );
    return rows[0] ?? null;
  }

  /** Supersession ancestry of a row: every predecessor, transitively, bounded. */
  private async ancestorsOf(tx: Tx, id: string): Promise<Set<string>> {
    const out = new Set<string>([id]);
    let frontier = [id];
    for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
      const rows = await tx
        .select({ id: memory.id })
        .from(memory)
        .where(inArray(memory.supersededBy, frontier));
      frontier = rows.map((row) => row.id).filter((rowId) => !out.has(rowId));
      for (const rowId of frontier) out.add(rowId);
    }
    return out;
  }

  /**
   * The most recent finding whose parties are ancestors of this pair (one on
   * each side, either orientation), excluding the exact pair itself — the
   * reopen/follow anchor (V2.3 item 6.1). Resolved rows preferred newest
   * first; an open row wins over any resolved one.
   */
  private async ancestralRelation(
    tx: Tx,
    incomingId: string,
    existingId: string,
  ): Promise<MemoryRelationRow | null> {
    const [ancestorsA, ancestorsB] = [
      await this.ancestorsOf(tx, incomingId),
      await this.ancestorsOf(tx, existingId),
    ];
    if (ancestorsA.size <= 1 && ancestorsB.size <= 1) return null;
    const sideA = [...ancestorsA];
    const sideB = [...ancestorsB];
    const rows = await tx
      .select()
      .from(memoryRelation)
      .where(
        and(
          eq(memoryRelation.kind, 'contradicts'),
          or(
            and(inArray(memoryRelation.aMemoryId, sideA), inArray(memoryRelation.bMemoryId, sideB)),
            and(inArray(memoryRelation.aMemoryId, sideB), inArray(memoryRelation.bMemoryId, sideA)),
          ),
        ),
      )
      .orderBy(
        sql`${memoryRelation.resolvedAt} IS NOT NULL`,
        desc(memoryRelation.resolvedAt),
        memoryRelation.id,
      )
      .for('update');
    const candidate = rows.find(
      (row) =>
        !(row.aMemoryId === incomingId && row.bMemoryId === existingId) &&
        !(row.aMemoryId === existingId && row.bMemoryId === incomingId),
    );
    return candidate ?? null;
  }

  /**
   * Moves a finding onto the current pair: party ids and prior statuses
   * updated, both parties transitioned to `contradicted`, the fresh reason
   * recorded; `clearResolution` additionally reopens a resolved row.
   */
  private async repointParties(
    tx: Tx,
    relation: MemoryRelationRow,
    incoming: MemoryRow,
    existing: MemoryRow,
    reason: string,
    opts: { clearResolution?: boolean } = {},
  ): Promise<MemoryRelationRow> {
    const [updated] = await tx
      .update(memoryRelation)
      .set({
        aMemoryId: incoming.id,
        bMemoryId: existing.id,
        aPriorStatus: incoming.status,
        bPriorStatus: existing.status,
        reason,
        ...(opts.clearResolution ? { resolvedAt: null, resolution: null } : {}),
      })
      .where(eq(memoryRelation.id, relation.id))
      .returning();
    for (const row of [incoming, existing]) {
      if (row.status !== 'contradicted') {
        await this.store.transitionInTx(tx, RECONCILER, row.id, 'contradicted', reason);
      }
    }
    return updated as MemoryRelationRow;
  }

  /** Locks both rows in id order (deadlock-free) and returns them. */
  private async lockPair(tx: Tx, idOne: string, idTwo: string): Promise<[MemoryRow, MemoryRow]> {
    if (idOne === idTwo)
      throw userError.badRequest('relation.selfPair', 'a memory cannot be paired with itself');
    const rows = await tx
      .select()
      .from(memory)
      .where(inArray(memory.id, [idOne, idTwo]))
      .orderBy(memory.id)
      .for('update');
    if (rows.length !== 2) {
      throw userError.notFound('relation.memoryGone', 'a memory in this pair no longer exists');
    }
    // Two facts in different spaces are not a pair at all
    // (docs/features/spaces.md): every pair action — merge, contradiction,
    // supersession, follow — funnels through this lock, so the wall holds at
    // the aggregate even if a caller upstream of the gated candidate reads
    // were ever broken. A developer error, never a user-visible one, because
    // no reachable request can construct the state.
    if (rows[0]!.spaceId !== rows[1]!.spaceId) {
      throw new Error(
        `memories ${idOne} and ${idTwo} live in different spaces and can never form a pair`,
      );
    }
    return [rows[0]!, rows[1]!];
  }

  // ── Resolution-outcome helpers (extracted from resolveContradiction;
  // each is behavior-preserving and runs inside the caller's `tx`) ─────────────

  /** Confirm: winner → user_approved; the loser is outdated or superseded. */
  private async applyConfirm(
    tx: Tx,
    user: MemoryActor,
    rowA: MemoryRow,
    rowB: MemoryRow,
    winnerSide: 'a' | 'b',
  ): Promise<RelationResolution> {
    const winner = winnerSide === 'a' ? rowA : rowB;
    const loser = winnerSide === 'a' ? rowB : rowA;
    if (winner.status !== 'contradicted' || loser.status !== 'contradicted') {
      throw userError.badRequest(
        'relation.changedSinceDetection',
        'a memory in this contradiction changed since detection, review it in Memories, then dismiss or correct instead',
      );
    }
    const confirmed = await this.store.transitionInTx(
      tx,
      user,
      winner.id,
      'user_approved',
      'contradiction resolution: confirmed by owner',
    );
    if (confirmLoserOutcome(asParty(confirmed), asParty(loser)) === 'outdated') {
      await this.store.transitionInTx(
        tx,
        user,
        loser.id,
        'outdated',
        'contradiction resolution: time-superseded by the confirmed fact',
      );
    } else {
      await this.closeAndPoint(
        tx,
        loser,
        confirmed,
        'memory.superseded',
        { supersededBy: confirmed.id, mechanism: 'contradiction_confirm' },
        actorLabel(user),
        eventTime(asParty(confirmed)),
      );
    }
    return winnerSide === 'a' ? 'confirmed_a' : 'confirmed_b';
  }

  /**
   * Correct: edit-as-supersession per memory (0006 ruling 3), atomically with
   * the relation resolution — both parties end `replaced` under user_approved
   * successors, which clears the warning chips.
   */
  private async applyCorrect(
    tx: Tx,
    principal: Principal,
    rowA: MemoryRow,
    rowB: MemoryRow,
    action: Extract<ContradictionResolveAction, { type: 'correct' }>,
  ): Promise<RelationResolution> {
    await this.store.editContentInTx(tx, principal, rowA.id, action.aContent);
    await this.store.editContentInTx(tx, principal, rowB.id, action.bContent);
    return 'corrected';
  }

  /** Dismiss: restore both parties to their pre-contradiction status. */
  private async applyDismiss(
    tx: Tx,
    user: MemoryActor,
    principal: Principal,
    rowA: MemoryRow,
    rowB: MemoryRow,
    relation: MemoryRelationRow,
  ): Promise<RelationResolution> {
    await restoreFromContradiction(
      tx,
      rowA,
      relation.aPriorStatus,
      'memory.contradiction_dismiss_restored',
      actorLabel(user),
      this.vectors,
      principal.orgId,
    );
    await restoreFromContradiction(
      tx,
      rowB,
      relation.bPriorStatus,
      'memory.contradiction_dismiss_restored',
      actorLabel(user),
      this.vectors,
      principal.orgId,
    );
    return 'dismissed';
  }

  /**
   * The spec §6 close: loser → `replaced`, interval closed, pointer at the
   * existing target row (no new row — this is what distinguishes a merge /
   * reconciliation supersession from edit-supersession). Payload copy last.
   */
  private async closeAndPoint(
    tx: Tx,
    loser: MemoryRow,
    target: MemoryRow,
    auditAction: 'memory.merged' | 'memory.superseded',
    detail: Record<string, unknown>,
    actor: string = actorLabel(RECONCILER),
    closeAt?: Date,
  ): Promise<void> {
    // Event time, never merge time (V2.3 item 6.1, issue D): a loser closed
    // at `now()` claimed the old fact held until the moment the ENGINE ran,
    // when what is known is that the winner's fact took over at its own
    // event time (validFrom, else when it was recorded).
    const validUntil = closeAt ?? target.validFrom ?? target.createdAt;
    await tx
      .update(memory)
      .set({ status: 'replaced', supersededBy: target.id, validUntil, updatedAt: new Date() })
      .where(eq(memory.id, loser.id));
    await writeAudit(tx, {
      actor,
      action: auditAction,
      entityType: 'memory',
      entityId: loser.id,
      detail: { ...detail, validUntil: validUntil.toISOString() },
      ownerId: loser.ownerId,
      orgId: await this.orgFor(loser.ownerId),
      spaceId: loser.spaceId,
    });
    await this.vectors?.setPayload(loser.id, {
      status: 'replaced',
      valid_until: validUntil.toISOString(),
    });
  }
}
