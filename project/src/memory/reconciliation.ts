import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Principal, RelationResolution } from '@cogeto/shared';
import { DRIZZLE, writeAudit } from '../infrastructure/index';
import { UserDirectory } from '../identity/index';
import type { Db, Tx } from '../infrastructure/index';
import { memory, memoryRelation } from './persistence/tables';
import type { MemoryRelationRow, MemoryRow } from './persistence/tables';
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
 * The Memory aggregate's reconciliation actions (decision 0010): the acting
 * half behind the pure policy in domain/reconcile-policy.ts. The ingestion
 * reconciliation service decides WHICH pairs to check and what the model
 * ruled; every state change lands here, so the invariants stay aggregate-owned
 * (§A.1 rule 4):
 *
 * - merges and reconciliation supersessions close intervals and point
 *   `superseded_by` — history is never destroyed (§B.2);
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
  | { action: 'superseded'; winnerId: string; loserId: string }
  | { action: 'skipped'; reason: string };

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
    /** Org resolution for audit stamping (QS-13, decision 0025); DI provides it. */
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
    // Advisory only — never persisted (QS-1, decision 0025).
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
        initialStatus: survivorRow.status,
      });
      finalSurvivor = successor;
      enriched = true;
    }

    // The model's merge rationale is NOT persisted (QS-1, decision 0025):
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
   */
  async createContradiction(
    tx: Tx,
    incomingId: string,
    existingId: string,
    reason: string,
  ): Promise<PairActionResult> {
    const [first, second] = await this.lockPair(tx, incomingId, existingId);
    const incoming = first.id === incomingId ? first : second;
    const existing = first.id === existingId ? first : second;
    if (incoming.status === 'replaced' || existing.status === 'replaced') {
      return { action: 'skipped', reason: 'a party is already replaced' };
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
        // Review queue reads — never in the org-readable audit trail (QS-1,
        // decision 0025). Erased with the relation (FK CASCADE with the pair).
        reason,
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
    await writeAudit(tx, {
      actor: actorLabel(RECONCILER),
      action: 'memory.contradiction_detected',
      entityType: 'memory_relation',
      entityId: relation.id,
      detail: { a: incoming.id, b: existing.id },
      ownerId: incoming.ownerId,
      orgId: await this.orgFor(incoming.ownerId),
    });
    return { action: 'contradiction_created', relationId: relation.id };
  }

  /**
   * `supersedes` verdict (0010 ruling 7): §B.2 mechanics against the existing
   * winner — interval closed, loser `replaced`, pointer set. The caller ran
   * the direction guard; this re-checks it defensively and skips rather than
   * ever superseding ambiguously.
   */
  async applySupersession(
    tx: Tx,
    winnerId: string,
    loserId: string,
    // Advisory only — never persisted (QS-1, decision 0025).
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
        ),
      )
      .orderBy(desc(memoryRelation.detectedAt), memoryRelation.id);
    return rows.map((row) => ({ relation: row.relation, a: row.a, b: row.b }));
  }

  async countOpenContradictions(principal: Principal): Promise<number> {
    return (await this.listOpenContradictions(principal)).length;
  }

  /**
   * Owner resolution of a contradiction (0010 ruling 3). One transaction:
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
      if (!relation) throw new NotFoundException(`relation ${relationId} not found`);
      if (relation.resolvedAt) return { relation, alreadyResolved: true };

      const [first, second] = await this.lockPair(tx, relation.aMemoryId, relation.bMemoryId);
      const rowA = first.id === relation.aMemoryId ? first : second;
      const rowB = first.id === relation.bMemoryId ? first : second;
      if (rowA.ownerId !== principal.userId || rowB.ownerId !== principal.userId) {
        // Existence must not leak — mirror of the store's owner checks.
        throw new NotFoundException(`relation ${relationId} not found`);
      }
      const user: MemoryActor = { kind: 'user', userId: principal.userId };

      // The three resolution outcomes (0010 ruling 3), each extracted to a
      // behavior-preserving helper (QS-41): confirm one party (loser outdated or
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
      await writeAudit(tx, {
        actor: actorLabel(user),
        action: 'memory.contradiction_resolved',
        entityType: 'memory_relation',
        entityId: relation.id,
        detail: { resolution, a: rowA.id, b: rowB.id },
        ownerId: principal.userId,
        orgId: principal.orgId,
      });
      return { relation: resolved as MemoryRelationRow, alreadyResolved: false };
    });
  }

  // ── Private mechanics ───────────────────────────────────────────────────────

  /** Locks both rows in id order (deadlock-free) and returns them. */
  private async lockPair(tx: Tx, idOne: string, idTwo: string): Promise<[MemoryRow, MemoryRow]> {
    if (idOne === idTwo) throw new BadRequestException('a memory cannot be paired with itself');
    const rows = await tx
      .select()
      .from(memory)
      .where(inArray(memory.id, [idOne, idTwo]))
      .orderBy(memory.id)
      .for('update');
    if (rows.length !== 2) {
      throw new NotFoundException('a memory in this pair no longer exists');
    }
    return [rows[0]!, rows[1]!];
  }

  // ── Resolution-outcome helpers (QS-41, extracted from resolveContradiction;
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
      throw new BadRequestException(
        'a memory in this contradiction changed since detection — review it in Memories, then dismiss or correct instead',
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
   * The §B.2 close: loser → `replaced`, interval closed, pointer at the
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
    const validUntil = closeAt ?? target.validFrom ?? new Date();
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
    });
    await this.vectors?.setPayload(loser.id, {
      status: 'replaced',
      valid_until: validUntil.toISOString(),
    });
  }
}
