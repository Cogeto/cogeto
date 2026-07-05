import { Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import type { FactKind, MemoryScope, MemoryStatus, Principal } from '@cogeto/shared';
import type { Tx } from '../../infrastructure/index';
import { MemoryReconciliation, MemoryStore, supersessionUnambiguous } from '../../memory/index';
import type { MemoryRow, PairActionResult } from '../../memory/index';
import { loadPrompt, ModelGateway } from '../../model-gateway/index';
import type { PromptArtifact } from '../../model-gateway/index';
import { verificationResult } from '../persistence/tables';
import { contradictionVerdictSchema, dedupVerdictSchema } from '../domain/reconcile-verdicts';
import type { ContradictionVerdict, DedupVerdict } from '../domain/reconcile-verdicts';
import { isContradictionCandidate, isDedupCandidate } from '../domain/reconcile-candidates';
import { RECONCILE_CONTRADICTION_PROMPT, RECONCILE_DEDUP_PROMPT } from '../prompt-versions';
import {
  CANDIDATE_TOP_K,
  CONTRADICTION_CANDIDATE_STATUSES,
  CONTRADICTION_KINDS,
  DEDUP_CANDIDATE_STATUSES,
  MAX_CHECKS_PER_FACT,
} from '../reconcile-config';
import type { PipelineLog } from './pipeline-log';

/**
 * Stage 6 (reconcile) — real from F2-A (decision 0010). ONE engine, two
 * drivers: the pipeline calls `reconcile` incrementally with the facts it
 * just admitted (inside the job's idempotency transaction, where those rows
 * are not yet committed); the F2-B dreaming cycle calls it in batch.
 *
 * Shape per incoming fact: deterministic candidate generation first (gated
 * primitives, versioned thresholds, zero model calls), then at most
 * MAX_CHECKS_PER_FACT model confirmations per family, then actions through
 * the Memory aggregate only. Anything short of an exact verdict does nothing:
 * a wrong merge destroys a distinct fact, a wrong contradiction wastes the
 * user's attention, and both are worse than doing nothing.
 */

/** The judge's view of one fact — plain data so the eval harness reuses it. */
export interface ReconcileFactView {
  content: string;
  kind: FactKind | null;
  entities: string[];
  subjectEntity: string | null;
  capturedAt: Date;
  validFrom: Date | null;
  validUntil: Date | null;
  sourceSpan?: string | null;
}

/** One admitted fact entering stage 6: its row plus the stage-5 embedding. */
export interface ReconcileInput {
  row: MemoryRow;
  embedding: number[];
}

export interface ReconcileSummary {
  considered: number;
  dedupChecks: number;
  contradictionChecks: number;
  merged: number;
  enriched: number;
  contradictions: number;
  superseded: number;
  /**
   * Every state-changing action taken, in order — the dreaming driver
   * persists these as dream_action rows (F2-B). The pipeline driver ignores
   * them (its ledger is the job log). Skipped results are not recorded.
   */
  actions: ReconcileActionRecord[];
}

export interface ReconcileActionRecord {
  /** The incoming fact of the pair. */
  factId: string;
  /** The existing memory it was checked against. */
  candidateId: string;
  result: PairActionResult;
}

function factBlock(label: string, fact: ReconcileFactView): string {
  const lines = [
    `${label}:`,
    `claim: ${fact.content}`,
    `kind: ${fact.kind ?? 'unknown'}`,
    `subject: ${fact.subjectEntity ?? 'unknown'}`,
    `entities: ${fact.entities.length > 0 ? fact.entities.join(', ') : '(none)'}`,
    `captured: ${fact.capturedAt.toISOString()}`,
  ];
  if (fact.validFrom || fact.validUntil) {
    lines.push(
      `holds: ${fact.validFrom?.toISOString() ?? 'unknown'} -> ${fact.validUntil?.toISOString() ?? 'open'}`,
    );
  }
  if (fact.sourceSpan) lines.push(`source passage: ${fact.sourceSpan}`);
  return lines.join('\n');
}

/** FACT A is the more recently recorded one — both prompts state this. */
export function buildPairInput(a: ReconcileFactView, b: ReconcileFactView): string {
  return [factBlock('FACT A', a), '', factBlock('FACT B', b)].join('\n');
}

/**
 * The model-confirmation half, DB-free: loads the two versioned prompts and
 * judges a pair. Shared verbatim by stage 6 and the eval harness so measured
 * behavior IS shipped behavior (§B.4).
 */
export class ReconcileJudge {
  private dedupPrompt?: PromptArtifact;
  private contradictionPrompt?: PromptArtifact;

  constructor(private readonly gateway: ModelGateway) {}

  async judgeDedup(a: ReconcileFactView, b: ReconcileFactView): Promise<DedupVerdict> {
    this.dedupPrompt ??= await loadPrompt(
      RECONCILE_DEDUP_PROMPT.family,
      RECONCILE_DEDUP_PROMPT.version,
    );
    return this.gateway.extractStructured(dedupVerdictSchema, {
      system: this.dedupPrompt.content,
      input: buildPairInput(a, b),
    });
  }

  async judgeContradiction(
    a: ReconcileFactView,
    b: ReconcileFactView,
  ): Promise<ContradictionVerdict> {
    this.contradictionPrompt ??= await loadPrompt(
      RECONCILE_CONTRADICTION_PROMPT.family,
      RECONCILE_CONTRADICTION_PROMPT.version,
    );
    return this.gateway.extractStructured(contradictionVerdictSchema, {
      system: this.contradictionPrompt.content,
      input: buildPairInput(a, b),
    });
  }
}

/**
 * Reconciliation acts on the owner's own memory, so the gated primitives run
 * with the owner as principal — the same gates as any read (0003 ruling 2).
 * Only userId participates in the gates; the identity fields are blank
 * because no display identity exists on the slow path.
 */
function ownerPrincipal(ownerId: string): Principal {
  return { userId: ownerId, name: '', email: null, orgId: '', orgName: '', roles: [] };
}

interface Candidate {
  row: MemoryRow;
  /** Normalized [0,1]; null when found by the entity path only. */
  similarity: number | null;
}

@Injectable()
export class ReconciliationService {
  private judge: ReconcileJudge;

  constructor(
    gateway: ModelGateway,
    private readonly memoryStore: MemoryStore,
    private readonly reconciliation: MemoryReconciliation,
  ) {
    this.judge = new ReconcileJudge(gateway);
  }

  async reconcile(tx: Tx, items: ReconcileInput[], log: PipelineLog): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      considered: 0,
      dedupChecks: 0,
      contradictionChecks: 0,
      merged: 0,
      enriched: 0,
      contradictions: 0,
      superseded: 0,
      actions: [],
    };
    const record = (factId: string, candidateId: string, result: PairActionResult) => {
      if (result.action !== 'skipped') summary.actions.push({ factId, candidateId, result });
    };

    for (const item of items) {
      const fact = item.row;
      // Re-runs and dreaming batches skip facts something already settled.
      if (fact.status !== 'active' && fact.status !== 'uncertain') continue;
      summary.considered += 1;

      const candidates = await this.gatherCandidates(fact, item.embedding);
      if (candidates.length === 0) continue;
      const spans = await this.loadSpans(tx, [fact.id, ...candidates.map((c) => c.row.id)]);
      const factView = this.toView(fact, spans);

      // ── Dedup: first confirmed same_fact merges and settles this fact. ──────
      const dedupCandidates = candidates
        .filter(
          (c) =>
            DEDUP_CANDIDATE_STATUSES.includes(c.row.status) &&
            isDedupCandidate(c.similarity, fact, c.row),
        )
        .slice(0, MAX_CHECKS_PER_FACT);
      let settled = false;
      const judgedDistinct = new Set<string>();
      for (const candidate of dedupCandidates) {
        summary.dedupChecks += 1;
        const verdict = await this.judge.judgeDedup(factView, this.toView(candidate.row, spans));
        if (verdict.verdict !== 'same_fact') {
          // distinct/related merge nothing; `distinct` above the dedup
          // threshold escalates to the contradiction check (0010 ruling 6).
          if (verdict.verdict === 'distinct') judgedDistinct.add(candidate.row.id);
          continue;
        }
        const result = await this.reconciliation.mergeSameFact(
          tx,
          fact.id,
          candidate.row.id,
          verdict.merged_content,
          verdict.reason,
        );
        this.logAction(log, fact.id, candidate.row.id, result);
        record(fact.id, candidate.row.id, result);
        if (result.action === 'merged') {
          summary.merged += 1;
          if (result.enriched) summary.enriched += 1;
          settled = true;
          break;
        }
      }
      if (settled) continue;

      // ── Contradiction: only verified facts earn warning chips. ─────────────
      if (
        fact.status !== 'active' ||
        !fact.kind ||
        !CONTRADICTION_KINDS.includes(fact.kind) ||
        !fact.subjectEntity
      ) {
        continue;
      }
      const contradictionCandidates = candidates
        .filter(
          (c) =>
            CONTRADICTION_CANDIDATE_STATUSES.includes(c.row.status) &&
            isContradictionCandidate(c.similarity, fact, c.row, judgedDistinct.has(c.row.id)),
        )
        .slice(0, MAX_CHECKS_PER_FACT);
      for (const candidate of contradictionCandidates) {
        summary.contradictionChecks += 1;
        const verdict = await this.judge.judgeContradiction(
          factView,
          this.toView(candidate.row, spans),
        );
        if (verdict.verdict === 'compatible') continue;

        let result: PairActionResult | null = null;
        if (verdict.verdict === 'supersedes' && verdict.direction) {
          const winner = verdict.direction === 'a_over_b' ? fact : candidate.row;
          const loser = verdict.direction === 'a_over_b' ? candidate.row : fact;
          if (supersessionUnambiguous(winner, loser)) {
            result = await this.reconciliation.applySupersession(
              tx,
              winner.id,
              loser.id,
              verdict.reason,
            );
            if (result.action === 'superseded') summary.superseded += 1;
          }
        }
        // contradicts, direction-less/ambiguous supersedes, and any skipped
        // supersession all route to the human (0010 ruling 7).
        if (!result || result.action === 'skipped') {
          result = await this.reconciliation.createContradiction(
            tx,
            fact.id,
            candidate.row.id,
            verdict.reason,
          );
          if (result.action === 'contradiction_created') summary.contradictions += 1;
        }
        this.logAction(log, fact.id, candidate.row.id, result);
        record(fact.id, candidate.row.id, result);
        // At most ONE contradiction action per fact per run (0010 ruling 6).
        break;
      }
    }
    return summary;
  }

  /**
   * Deterministic candidate generation (0010 ruling 6): gated vector search
   * narrowed to the owner's rows in the fact's scope, plus the entity path.
   * Zero model calls. Same-source rows are excluded — reconciliation is
   * new-vs-existing, never within-batch.
   */
  private async gatherCandidates(fact: MemoryRow, embedding: number[]): Promise<Candidate[]> {
    const principal = ownerPrincipal(fact.ownerId);
    const readOpts = { includeSensitive: fact.sensitive };
    const eligibleStatuses = [
      ...new Set([...DEDUP_CANDIDATE_STATUSES, ...CONTRADICTION_CANDIDATE_STATUSES]),
    ];

    const hits = await this.memoryStore.vectorSearch(principal, embedding, {
      ...readOpts,
      topK: CANDIDATE_TOP_K,
      scope: fact.scope as MemoryScope,
      ownerOnly: true,
      statuses: eligibleStatuses as MemoryStatus[],
    });
    const similarityById = new Map(hits.map((h) => [h.memoryId, h.score]));
    const rows = await this.memoryStore.getManyForPrincipal(
      principal,
      hits.map((h) => h.memoryId),
      readOpts,
    );

    const entityRows =
      fact.entities.length > 0 && fact.kind
        ? (
            await this.memoryStore.entitySearch(principal, fact.entities, {
              ...readOpts,
              topK: CANDIDATE_TOP_K,
              scope: fact.scope as MemoryScope,
            })
          ).map((scored) => scored.memory)
        : [];

    const byId = new Map<string, MemoryRow>();
    for (const row of [...rows, ...entityRows]) byId.set(row.id, row);

    const candidates: Candidate[] = [];
    for (const row of byId.values()) {
      if (row.id === fact.id) continue;
      if (row.sourceType === fact.sourceType && row.sourceId === fact.sourceId) continue;
      if (row.ownerId !== fact.ownerId || row.scope !== fact.scope) continue;
      if (!eligibleStatuses.includes(row.status)) continue;
      candidates.push({ row, similarity: similarityById.get(row.id) ?? null });
    }
    // Best-similarity first; entity-only candidates follow the scored ones.
    return candidates.sort((x, y) => (y.similarity ?? -1) - (x.similarity ?? -1));
  }

  /** Cited source passages give the judge evidence, not just claims (§B.3 spirit). */
  private async loadSpans(tx: Tx, memoryIds: string[]): Promise<Map<string, string | null>> {
    if (memoryIds.length === 0) return new Map();
    const rows = await tx
      .select({ memoryId: verificationResult.memoryId, span: verificationResult.sourceSpan })
      .from(verificationResult)
      .where(inArray(verificationResult.memoryId, memoryIds));
    return new Map(rows.map((r) => [r.memoryId, r.span]));
  }

  private toView(row: MemoryRow, spans: Map<string, string | null>): ReconcileFactView {
    return {
      content: row.content ?? '',
      kind: row.kind,
      entities: row.entities,
      subjectEntity: row.subjectEntity,
      capturedAt: row.createdAt,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      sourceSpan: spans.get(row.id) ?? null,
    };
  }

  private logAction(
    log: PipelineLog,
    factId: string,
    candidateId: string,
    result: PairActionResult,
  ) {
    log(
      { stage: 'reconcile', fact: factId, candidate: candidateId, ...result },
      `reconcile: ${result.action}`,
    );
  }
}
