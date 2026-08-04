import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { Principal } from '@cogeto/shared';
import { DRIZZLE, writeAudit } from '../../infrastructure/index';
import type { Db, DbOrTx, Tx } from '../../infrastructure/index';
import { extractionGate, extractionGateRefusal, extractionGateRule } from './tables';
import type {
  ExtractionGateRefusalRow,
  ExtractionGateRow,
  ExtractionGateRuleRow,
  ExtractionRefusalReason,
} from './tables';

/**
 * The per-source extraction gate (V2.1 item 4.3, spec 1.6): admission control
 * over extraction, decided by plain table reads at one chokepoint in the
 * pipeline, before any model spend. The analogue of the first-person rule: a
 * cheap deterministic per-source predicate, never a model judgment.
 *
 * An ABSENT gate row is today's behaviour, byte-identical: enabled, the
 * source-type registry's fact budget, no retention. A gate row only ever
 * narrows. Refusals are recorded in a metadata-only ledger (the email_refusal
 * precedent), so a blocked source never looks processed-with-zero-facts.
 */

/**
 * Rule dimensions code binds TODAY. 'channel' and 'folder' are reserved for
 * observed connectors (V2.4 item 8.x) and bulk import (V2.2 item 5.3): the
 * table accepts them the day something enforces them, no migration — but the
 * API refuses them until then, because accepting a rule nothing enforces would
 * be a control that silently does not control.
 */
export const EXTRACTION_RULE_DIMENSIONS = ['document_class', 'source_id'] as const;
export type ExtractionRuleDimension = (typeof EXTRACTION_RULE_DIMENSIONS)[number];

/** Refusal-ledger retention, mirroring the email refusal ledger's. */
export const EXTRACTION_REFUSAL_RETENTION_DAYS = 30;
export const EXTRACTION_REFUSAL_RETENTION_JOB_TYPE = 'extraction_refusal_retention';
/** Nightly, 5 minutes after the email refusal prune (03:50). */
export const EXTRACTION_REFUSAL_RETENTION_CRONTAB = `55 3 * * * ${EXTRACTION_REFUSAL_RETENTION_JOB_TYPE}`;

export interface GateDecisionInput {
  ownerId: string;
  sourceType: string;
  sourceId: string;
  /** The reading layer's detected format, when the reader stamped one. */
  documentClass?: string;
}

export type GateDecision =
  | {
      allowed: true;
      /** NULL: the registry budget (and the parse cap) decide. */
      factBudget: number | null;
      /** NULL: no gate retention; facts keep their own validity. */
      retentionDays: number | null;
    }
  | { allowed: false; reason: ExtractionRefusalReason; documentClass?: string };

export interface SetGateRequest {
  enabled?: boolean;
  factBudget?: number | null;
  retentionDays?: number | null;
}

export interface AddRuleRequest {
  sourceType: string;
  dimension: ExtractionRuleDimension;
  value: string;
  effect: 'allow' | 'deny';
}

export interface ExtractionGateConfig {
  gates: ExtractionGateRow[];
  rules: ExtractionGateRuleRow[];
  recentRefusals: ExtractionGateRefusalRow[];
}

const RECENT_REFUSALS_LIMIT = 20;

@Injectable()
export class ExtractionGateStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The pipeline's single question, answered inside the job's transaction:
   * may this source be extracted, and under which budget and retention?
   *
   * Rule evaluation, per dimension:
   * - `source_id`: a deny row for this exact source refuses it. Allow rows are
   *   not accepted on this dimension (the API refuses them): "only this one
   *   document" is not a control anyone asked for, and a half-meant allowlist
   *   over ids would silently disable a whole connector.
   * - `document_class`: a deny row for the detected class refuses; if any
   *   allow rows exist, the detected class must be among them (a closed list,
   *   the email-allowlist semantics). Sources without a detected class (notes,
   *   chat, email bodies, web pages) are untouched by class rules.
   */
  async decisionFor(tx: DbOrTx, input: GateDecisionInput): Promise<GateDecision> {
    const [gates, rules] = await Promise.all([
      tx
        .select()
        .from(extractionGate)
        .where(
          and(
            eq(extractionGate.ownerId, input.ownerId),
            eq(extractionGate.sourceType, input.sourceType),
          ),
        )
        .limit(1),
      tx
        .select()
        .from(extractionGateRule)
        .where(
          and(
            eq(extractionGateRule.ownerId, input.ownerId),
            eq(extractionGateRule.sourceType, input.sourceType),
          ),
        ),
    ]);

    return evaluateGateDecision(gates[0], rules, input);
  }

  /**
   * The honest record of a refusal, written inside the pipeline's transaction
   * so the ledger describes exactly the runs that happened. Metadata only,
   * never content.
   */
  async recordRefusal(
    tx: Tx,
    entry: {
      ownerId: string;
      sourceType: string;
      sourceId: string;
      reason: ExtractionRefusalReason;
      documentClass?: string;
    },
  ): Promise<void> {
    await tx.insert(extractionGateRefusal).values({
      ownerId: entry.ownerId,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      reason: entry.reason,
      documentClass: entry.documentClass ?? null,
    });
  }

  /** The owner's gate configuration plus the recent refusals, for the panel. */
  async configFor(principal: Principal): Promise<ExtractionGateConfig> {
    const [gates, rules, recentRefusals] = await Promise.all([
      this.db
        .select()
        .from(extractionGate)
        .where(eq(extractionGate.ownerId, principal.userId))
        .orderBy(extractionGate.sourceType),
      this.db
        .select()
        .from(extractionGateRule)
        .where(eq(extractionGateRule.ownerId, principal.userId))
        .orderBy(extractionGateRule.sourceType, extractionGateRule.dimension),
      this.db
        .select()
        .from(extractionGateRefusal)
        .where(eq(extractionGateRefusal.ownerId, principal.userId))
        .orderBy(desc(extractionGateRefusal.refusedAt))
        .limit(RECENT_REFUSALS_LIMIT),
    ]);
    return { gates, rules, recentRefusals };
  }

  /**
   * Upsert the owner's gate row for one source type. Audited with structural
   * detail only (which knobs changed), never values that could carry content.
   */
  async setGate(
    principal: Principal,
    sourceType: string,
    request: SetGateRequest,
  ): Promise<ExtractionGateRow> {
    return this.db.transaction(async (tx) => {
      const existing = (
        await tx
          .select()
          .from(extractionGate)
          .where(
            and(
              eq(extractionGate.ownerId, principal.userId),
              eq(extractionGate.sourceType, sourceType),
            ),
          )
          .limit(1)
      )[0];

      const next = {
        enabled: request.enabled ?? existing?.enabled ?? true,
        factBudget:
          request.factBudget !== undefined ? request.factBudget : (existing?.factBudget ?? null),
        retentionDays:
          request.retentionDays !== undefined
            ? request.retentionDays
            : (existing?.retentionDays ?? null),
      };

      const row = existing
        ? (
            await tx
              .update(extractionGate)
              .set({ ...next, updatedAt: new Date() })
              .where(eq(extractionGate.id, existing.id))
              .returning()
          )[0]!
        : (
            await tx
              .insert(extractionGate)
              .values({ ownerId: principal.userId, sourceType, ...next })
              .returning()
          )[0]!;

      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'extraction_gate.set',
        entityType: 'extraction_gate',
        entityId: row.id,
        detail: {
          sourceType,
          enabled: next.enabled,
          hasFactBudget: next.factBudget !== null,
          hasRetention: next.retentionDays !== null,
        },
        orgId: principal.orgId,
        ownerId: principal.userId,
      });
      return row;
    });
  }

  /** Idempotent rule insert, audited with structural detail only. */
  async addRule(principal: Principal, request: AddRuleRequest): Promise<ExtractionGateRuleRow> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(extractionGateRule)
        .values({
          ownerId: principal.userId,
          sourceType: request.sourceType,
          dimension: request.dimension,
          value: request.value,
          effect: request.effect,
        })
        .onConflictDoNothing()
        .returning();

      const row =
        inserted[0] ??
        (
          await tx
            .select()
            .from(extractionGateRule)
            .where(
              and(
                eq(extractionGateRule.ownerId, principal.userId),
                eq(extractionGateRule.sourceType, request.sourceType),
                eq(extractionGateRule.dimension, request.dimension),
                eq(extractionGateRule.value, request.value),
              ),
            )
            .limit(1)
        )[0]!;

      if (inserted[0]) {
        await writeAudit(tx, {
          actor: `user:${principal.userId}`,
          action: 'extraction_gate.rule_added',
          entityType: 'extraction_gate_rule',
          entityId: row.id,
          detail: {
            sourceType: request.sourceType,
            dimension: request.dimension,
            effect: request.effect,
          },
          orgId: principal.orgId,
          ownerId: principal.userId,
        });
      }
      return row;
    });
  }

  /** Removes the owner's own rule; a foreign id removes nothing. */
  async removeRule(principal: Principal, id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(extractionGateRule)
        .where(and(eq(extractionGateRule.id, id), eq(extractionGateRule.ownerId, principal.userId)))
        .returning({ id: extractionGateRule.id });
      if (removed.length === 0) return false;
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'extraction_gate.rule_removed',
        entityType: 'extraction_gate_rule',
        entityId: id,
        orgId: principal.orgId,
        ownerId: principal.userId,
      });
      return true;
    });
  }

  /** Nightly hygiene prune of the metadata-only refusal ledger. */
  async pruneRefusalsOlderThan(days = EXTRACTION_REFUSAL_RETENTION_DAYS): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 3_600_000);
    const removed = await this.db
      .delete(extractionGateRefusal)
      .where(lt(extractionGateRefusal.refusedAt, cutoff))
      .returning({ id: extractionGateRefusal.id });
    return removed.length;
  }

  /**
   * Deletion-saga leg (through ingestion's cascade): refusal rows reference an
   * erased source's identifier, and a dangling provenance reference is exactly
   * what the sweep would have to learn to ignore. Metadata only, but it goes.
   */
  async deleteRefusalsForSources(
    tx: Tx,
    refs: readonly { sourceType: string; sourceId: string }[],
  ): Promise<number> {
    if (refs.length === 0) return 0;
    const clauses = refs.map((ref) =>
      and(
        eq(extractionGateRefusal.sourceType, ref.sourceType),
        eq(extractionGateRefusal.sourceId, ref.sourceId),
      )!,
    );
    const removed = await tx
      .delete(extractionGateRefusal)
      .where(or(...clauses)!)
      .returning({ id: extractionGateRefusal.id });
    return removed.length;
  }
}

/**
 * The gate predicate itself, pure: rows in, decision out. Factored out of the
 * store so the rule semantics are unit-testable without a database, the
 * first-person rule's `firstPersonSource` precedent.
 */
export function evaluateGateDecision(
  gate: Pick<ExtractionGateRow, 'enabled' | 'factBudget' | 'retentionDays'> | undefined,
  rules: Pick<ExtractionGateRuleRow, 'dimension' | 'value' | 'effect'>[],
  input: Pick<GateDecisionInput, 'sourceId' | 'documentClass'>,
): GateDecision {
  if (gate && !gate.enabled) return { allowed: false, reason: 'extraction_disabled' };

  const sourceDenied = rules.some(
    (rule) =>
      rule.dimension === 'source_id' && rule.effect === 'deny' && rule.value === input.sourceId,
  );
  if (sourceDenied) return { allowed: false, reason: 'source_disabled' };

  if (input.documentClass !== undefined) {
    const classRules = rules.filter((rule) => rule.dimension === 'document_class');
    const denied = classRules.some(
      (rule) => rule.effect === 'deny' && rule.value === input.documentClass,
    );
    const allowRules = classRules.filter((rule) => rule.effect === 'allow');
    const allowMiss =
      allowRules.length > 0 && !allowRules.some((rule) => rule.value === input.documentClass);
    if (denied || allowMiss) {
      return {
        allowed: false,
        reason: 'document_class_denied',
        documentClass: input.documentClass,
      };
    }
  }

  return {
    allowed: true,
    factBudget: gate?.factBudget ?? null,
    retentionDays: gate?.retentionDays ?? null,
  };
}

/** Composition helper for non-Nest callers (integration tests, eval). */
export function createExtractionGateStore(db: Db): ExtractionGateStore {
  return new ExtractionGateStore(db);
}
