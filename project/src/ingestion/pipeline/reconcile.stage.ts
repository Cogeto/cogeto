import { Inject, Injectable, Optional } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import type {
  FactKind,
  MemoryScope,
  MemoryStatus,
  Principal,
  RelationDetector,
} from '@cogeto/shared';
import type { Tx } from '../../infrastructure/index';
import { MemoryReconciliation, MemoryStore, supersessionUnambiguous } from '../../memory/index';
import type { MemoryRow, PairActionResult } from '../../memory/index';
import { loadPrompt, ModelGateway } from '../../model-gateway/index';
import type { PromptArtifact } from '../../model-gateway/index';
import { verificationResult } from '../persistence/tables';
import { CheckedPairStore } from '../persistence/checked-pair.store';
import { EntityAliasStore } from '../persistence/entity-alias.store';
import { SourceRevisionStore } from '../persistence/source-revision.store';
import { contradictionVerdictSchema, dedupVerdictSchema } from '../domain/reconcile-verdicts';
import type { ContradictionVerdict, DedupVerdict } from '../domain/reconcile-verdicts';
import {
  isContradictionCandidate,
  isDedupCandidate,
  subjectMatchKind,
} from '../domain/reconcile-candidates';
import type { DedupRuling } from '../domain/reconcile-candidates';
import { EMPTY_ALIAS_INDEX, EntityAliasIndex } from '../domain/entity-match';
import { compareQuantities, describeQuantities } from '../domain/quantity';
import type { QuantityDecision } from '../domain/quantity';
import { RECONCILE_CONTRADICTION_PROMPT, RECONCILE_DEDUP_PROMPT } from '../prompt-versions';
import {
  CANDIDATE_TOP_K,
  CONTRADICTION_CANDIDATE_STATUSES,
  CONTRADICTION_KINDS,
  DEDUP_CANDIDATE_STATUSES,
  MAX_CHECKS_PER_FACT,
  RECONCILE_CONFIG_VERSION,
  reconcileThresholdsFor,
} from '../reconcile-config';
import type { ReconcileThresholds } from '../reconcile-config';
import type { PipelineLog } from './pipeline-log';

/**
 * Stage 6 (reconcile) — real. ONE engine, THREE
 * drivers: the pipeline calls `reconcile` incrementally with the facts it
 * just admitted (inside the job's idempotency transaction, where those rows
 * are not yet committed); the dreaming cycle calls it in batch; the repair
 * job re-runs it over a source a few minutes after commit, because facts
 * admitted by concurrent jobs are invisible to each other's inline pass.
 *
 * Shape per incoming fact: deterministic candidate generation first (gated
 * primitives, calibrated thresholds, zero model calls), then the judged-pair
 * LEDGER (an unchanged pair keeps its verdict — no re-judging, no nightly
 * flip-flop, no token cost), then at most MAX_CHECKS_PER_FACT fresh model
 * confirmations per family ranked by conflict likelihood, then actions
 * through the Memory aggregate only. Anything short of an exact verdict does
 * nothing: a wrong merge destroys a distinct fact, a wrong contradiction
 * wastes the user's attention, and both are worse than doing nothing.
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
  /** Pairs settled from the ledger with zero model calls (V2.3 item 6.1). */
  ledgerHits: number;
  /** Pairs settled by the deterministic quantity comparison, no model call. */
  deterministicChecks: number;
  merged: number;
  enriched: number;
  contradictions: number;
  /** Findings reopened rather than minted (docs/features/findings.md). */
  reopened: number;
  superseded: number;
  /** Findings auto-resolved because a supersession settled the conflict. */
  resolvedByRevision: number;
  /**
   * Every state-changing action taken, in order — the dreaming driver
   * persists these as dream_action rows. The pipeline driver ignores
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

function emptySummary(): ReconcileSummary {
  return {
    considered: 0,
    dedupChecks: 0,
    contradictionChecks: 0,
    ledgerHits: 0,
    deterministicChecks: 0,
    merged: 0,
    enriched: 0,
    contradictions: 0,
    reopened: 0,
    superseded: 0,
    resolvedByRevision: 0,
    actions: [],
  };
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

/**
 * FACT A is the more recently recorded one — both prompts state this. When
 * the deterministic parser found quantities on BOTH sides, they are appended
 * as a PARSED QUANTITIES block (reconcile_contradiction/v0002): the judge
 * compares converted values instead of doing arithmetic in its head. Absent
 * quantities the input is byte-identical to the v0001 shape.
 */
export function buildPairInput(a: ReconcileFactView, b: ReconcileFactView): string {
  const blocks = [factBlock('FACT A', a), '', factBlock('FACT B', b)];
  const quantitiesA = describeQuantities(a.content);
  const quantitiesB = describeQuantities(b.content);
  if (quantitiesA.length > 0 && quantitiesB.length > 0) {
    blocks.push(
      '',
      'PARSED QUANTITIES:',
      ...quantitiesA.map((line) => `FACT A: ${line}`),
      ...quantitiesB.map((line) => `FACT B: ${line}`),
    );
  }
  return blocks.join('\n');
}

/**
 * The model-confirmation half, DB-free: loads the two versioned prompts and
 * judges a pair. Shared verbatim by stage 6 and the eval harness so measured
 * behavior IS shipped behavior (spec §14).
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
 * Update-relationship markers: when either claim announces a CHANGE, a
 * deterministic numeric conflict may actually be a supersession, so the pair
 * escalates to the judge instead of short-circuiting to a contradiction.
 */
const UPDATE_LANGUAGE =
  /\b(moved|now|instead|no longer|effective|revised|updated|changed|umjesto|više ne|premješteno|sada|od sada|vrijedi od|izmijenjen|ažuriran)\b/i;

/**
 * The deterministic arm (V2.3 item 6.1, issue C): a same-slot numeric
 * conflict with no update language and no temporal ordering IS the verdict —
 * no model call. Pure, shared verbatim with the eval harness.
 */
export function deterministicContradiction(
  a: ReconcileFactView,
  b: ReconcileFactView,
): { decision: QuantityDecision; conclusive: boolean } {
  const decision = compareQuantities(a.content, b.content);
  if (decision.decision !== 'conflict') return { decision, conclusive: false };
  if (UPDATE_LANGUAGE.test(a.content) || UPDATE_LANGUAGE.test(b.content)) {
    return { decision, conclusive: false };
  }
  // Cleanly ordered event times mean a supersedes reading is on the table;
  // only the judge may take it (the direction guard applies there).
  const eventA = (a.validFrom ?? a.capturedAt).getTime();
  const eventB = (b.validFrom ?? b.capturedAt).getTime();
  if (a.validFrom || b.validFrom) {
    if (eventA !== eventB) return { decision, conclusive: false };
  }
  return { decision, conclusive: true };
}

/** The ledger's name for the deterministic rule (its "prompt version"). */
export const DETERMINISTIC_QUANTITY_RULE = 'deterministic:quantity-v1';

/**
 * The generation binding recorded beside every ledger verdict, provided by
 * the composition root as `<provider>/<model>` for the pipeline tier. A
 * model change re-opens judged pairs by making this string disagree.
 */
export const RECONCILE_MODEL_CONFIG = Symbol('RECONCILE_MODEL_CONFIG');

/**
 * Reconciliation acts on the owner's own memory, so the gated primitives run
 * with the owner as principal — the same gates as any read (0003 ruling 2).
 * Only userId and spaceId participate in the gates; the identity fields are
 * blank because no display identity exists on the slow path. The space is the
 * SUBJECT ROW'S space (docs/features/spaces.md): reconciliation never pairs
 * across spaces, and carrying the row's space through the gate is what
 * enforces it in every candidate read.
 */
function ownerPrincipal(ownerId: string, spaceId: string): Principal {
  return { userId: ownerId, name: '', email: null, orgId: '', orgName: '', roles: [], spaceId };
}

interface Candidate {
  row: MemoryRow;
  /** Normalized [0,1]; null when found by the entity/subject path only. */
  similarity: number | null;
}

export interface ReconcileOptions {
  /** WHICH neighbours a fact may be compared against; see the note below. */
  exclude: 'same_batch' | 'same_source';
  /** Which pass this is, stamped on every finding (V2.3 item 6.1). */
  detectedBy?: RelationDetector;
  /** Explicit re-run: ignore the ledger and re-judge every pair. */
  rejudge?: boolean;
}

@Injectable()
export class ReconciliationService {
  private judge: ReconcileJudge;
  private aliasCache = new Map<string, EntityAliasIndex>();

  constructor(
    private readonly gateway: ModelGateway,
    private readonly memoryStore: MemoryStore,
    private readonly reconciliation: MemoryReconciliation,
    /** Optional so bare harnesses run without them; DI always provides them. */
    @Optional() private readonly ledger?: CheckedPairStore,
    @Optional() private readonly aliases?: EntityAliasStore,
    @Optional() private readonly revisions?: SourceRevisionStore,
    @Optional()
    @Inject(RECONCILE_MODEL_CONFIG)
    private readonly reconcileModelConfig?: string | (() => string),
  ) {
    this.judge = new ReconcileJudge(gateway);
  }

  /** Calibrated for the ACTIVE embedding model; throws on an unknown one. */
  private thresholds(): ReconcileThresholds {
    return reconcileThresholdsFor(this.gateway.embeddingModelId());
  }

  /**
   * The generation binding the ledger records beside each verdict. Resolved on
   * every call rather than captured: since V2.4 item 7.1 the binding can change
   * while the process runs, and a stale label is a pair silently not re-judged.
   */
  private modelConfig(): string {
    if (typeof this.reconcileModelConfig === 'function') return this.reconcileModelConfig();
    return this.reconcileModelConfig ?? 'unconfigured';
  }

  /**
   * `options.exclude` states WHICH neighbours a fact may be compared against,
   * and the callers need different rules:
   *
   * - The **pipeline** excludes the facts admitted by the same run. One
   *   document legitimately says several related things, and merging them
   *   against each other as they arrive would destroy distinct facts.
   * - **Dreaming** and the **repair job** exclude the same SOURCE instead.
   *   Their batch is a corpus being re-examined, so excluding it would leave
   *   nothing to compare.
   *
   * Until V2.1 item 4.1 both were served by one source-based rule, because a
   * source was only ever ingested once and "same source" and "same run" were
   * the same set. Reprocessing separated them: a document re-read after vision
   * is enabled must reconcile against its own earlier reading, which the
   * source rule forbade, so every recovered fact arrived as a duplicate.
   */
  async reconcile(
    tx: Tx,
    items: ReconcileInput[],
    log: PipelineLog,
    options: ReconcileOptions = { exclude: 'same_batch' },
  ): Promise<ReconcileSummary> {
    const detectedBy = options.detectedBy ?? 'pipeline';
    // Aliases are read fresh per reconcile call: an alias the owner just
    // recorded must reach the very next batch.
    this.aliasCache.clear();
    const summary: ReconcileSummary = emptySummary();
    const record = (factId: string, candidateId: string, result: PairActionResult) => {
      if (result.action !== 'skipped') summary.actions.push({ factId, candidateId, result });
    };
    const thresholds = this.thresholds();
    /** Everything in this call; see the `options` note above. */
    const batchIds = new Set(items.map((item) => item.row.id));

    for (const item of items) {
      const fact = item.row;
      // Re-runs and dreaming batches skip facts something already settled.
      if (fact.status !== 'active' && fact.status !== 'uncertain') continue;
      summary.considered += 1;
      const aliasIndex = await this.aliasIndexFor(fact.ownerId, fact.spaceId);

      const candidates = await this.gatherCandidates(
        fact,
        item.embedding,
        batchIds,
        options.exclude,
        aliasIndex,
      );
      if (candidates.length === 0) continue;
      const spans = await this.loadSpans(tx, [fact.id, ...candidates.map((c) => c.row.id)]);
      const factView = this.toView(fact, spans);

      // ── Dedup: first confirmed same_fact merges and settles this fact. ──────
      const dedupCandidates = candidates.filter(
        (c) =>
          DEDUP_CANDIDATE_STATUSES.includes(c.row.status) &&
          isDedupCandidate(c.similarity, fact, c.row, thresholds, aliasIndex),
      );
      let settled = false;
      const dedupRulings = new Map<string, DedupRuling>();
      let dedupBudget = MAX_CHECKS_PER_FACT;
      for (const candidate of dedupCandidates) {
        const verdict = await this.dedupVerdict(tx, fact, candidate, factView, spans, {
          budgetLeft: dedupBudget,
          rejudge: options.rejudge ?? false,
          summary,
        });
        if (verdict === null) continue; // out of budget, never judged
        if (verdict.fresh) dedupBudget -= 1;
        if (verdict.verdict !== 'same_fact') {
          if (verdict.verdict === 'distinct' || verdict.verdict === 'related') {
            dedupRulings.set(candidate.row.id, verdict.verdict);
          }
          continue;
        }
        const result = await this.reconciliation.mergeSameFact(
          tx,
          fact.id,
          candidate.row.id,
          verdict.mergedContent,
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
      const contradictionCandidates = this.rankByConflictLikelihood(
        candidates.filter(
          (c) =>
            CONTRADICTION_CANDIDATE_STATUSES.includes(c.row.status) &&
            isContradictionCandidate(
              c.similarity,
              fact,
              c.row,
              thresholds,
              dedupRulings.get(c.row.id) ?? null,
              aliasIndex,
              { dedupEligible: DEDUP_CANDIDATE_STATUSES.includes(c.row.status) },
            ),
        ),
        fact,
      );
      let contradictionBudget = MAX_CHECKS_PER_FACT;
      for (const candidate of contradictionCandidates) {
        const judged = await this.contradictionVerdict(tx, fact, candidate, factView, spans, {
          budgetLeft: contradictionBudget,
          rejudge: options.rejudge ?? false,
          summary,
        });
        if (judged === null) continue; // out of budget, never judged
        if (judged.fresh) contradictionBudget -= 1;
        if (judged.verdict === 'compatible') continue;

        let result: PairActionResult | null = null;
        if (judged.verdict === 'supersedes' && judged.direction) {
          const winner = judged.direction === 'a_over_b' ? fact : candidate.row;
          const loser = judged.direction === 'a_over_b' ? candidate.row : fact;
          if (supersessionUnambiguous(winner, loser)) {
            result = await this.reconciliation.applySupersession(
              tx,
              winner.id,
              loser.id,
              judged.reason,
            );
            if (result.action === 'superseded') {
              summary.superseded += 1;
              summary.resolvedByRevision += await this.settleFindingsAfterSupersession(
                tx,
                winner,
                loser,
                spans,
                log,
              );
            }
          }
        }
        // contradicts, direction-less/ambiguous supersedes, and any skipped
        // supersession all route to the human (0010 ruling 7).
        if (!result || result.action === 'skipped') {
          result = await this.reconciliation.createContradiction(
            tx,
            fact.id,
            candidate.row.id,
            judged.reason,
            detectedBy,
          );
          if (result.action === 'contradiction_created') summary.contradictions += 1;
          if (result.action === 'contradiction_reopened') summary.reopened += 1;
        }
        this.logAction(log, fact.id, candidate.row.id, result);
        record(fact.id, candidate.row.id, result);
        // At most ONE contradiction action per fact per run (0010 ruling 6).
        break;
      }
    }
    return summary;
  }

  // ── Judging with the ledger in front (V2.3 item 6.1, issue D) ──────────────

  private async dedupVerdict(
    tx: Tx,
    fact: MemoryRow,
    candidate: Candidate,
    factView: ReconcileFactView,
    spans: Map<string, string | null>,
    opts: { budgetLeft: number; rejudge: boolean; summary: ReconcileSummary },
  ): Promise<{
    verdict: DedupVerdict['verdict'];
    reason: string;
    mergedContent: string | null;
    fresh: boolean;
  } | null> {
    const active = {
      promptVersion: `${RECONCILE_DEDUP_PROMPT.family}/${RECONCILE_DEDUP_PROMPT.version}`,
      modelConfig: this.modelConfig(),
    };
    if (!opts.rejudge && this.ledger) {
      const recorded = await this.ledger.currentVerdict(
        tx,
        fact.id,
        candidate.row.id,
        'dedup',
        active,
      );
      if (recorded) {
        opts.summary.ledgerHits += 1;
        // A recorded same_fact whose merge already applied re-skips inside
        // mergeSameFact; replaying the verdict is idempotent by design.
        return {
          verdict: recorded.verdict as DedupVerdict['verdict'],
          reason: 'ledger: unchanged pair keeps its verdict',
          mergedContent: null,
          fresh: false,
        };
      }
    }
    if (opts.budgetLeft <= 0) return null;
    opts.summary.dedupChecks += 1;
    const verdict = await this.judge.judgeDedup(factView, this.toView(candidate.row, spans));
    await this.ledger?.record(tx, fact.id, candidate.row.id, {
      ownerId: fact.ownerId,
      spaceId: fact.spaceId,
      family: 'dedup',
      verdict: verdict.verdict,
      similarity: candidate.similarity,
      promptVersion: active.promptVersion,
      modelConfig: active.modelConfig,
      configVersion: RECONCILE_CONFIG_VERSION,
    });
    return {
      verdict: verdict.verdict,
      reason: verdict.reason,
      mergedContent: verdict.merged_content,
      fresh: true,
    };
  }

  private async contradictionVerdict(
    tx: Tx,
    fact: MemoryRow,
    candidate: Candidate,
    factView: ReconcileFactView,
    spans: Map<string, string | null>,
    opts: { budgetLeft: number; rejudge: boolean; summary: ReconcileSummary },
  ): Promise<{
    verdict: ContradictionVerdict['verdict'];
    direction: ContradictionVerdict['direction'];
    reason: string;
    fresh: boolean;
  } | null> {
    const candidateView = this.toView(candidate.row, spans);
    const active = {
      promptVersion: `${RECONCILE_CONTRADICTION_PROMPT.family}/${RECONCILE_CONTRADICTION_PROMPT.version}`,
      modelConfig: this.modelConfig(),
    };
    if (!opts.rejudge && this.ledger) {
      const recorded =
        (await this.ledger.currentVerdict(tx, fact.id, candidate.row.id, 'contradiction', {
          promptVersion: DETERMINISTIC_QUANTITY_RULE,
          modelConfig: active.modelConfig,
        })) ??
        (await this.ledger.currentVerdict(tx, fact.id, candidate.row.id, 'contradiction', active));
      if (recorded) {
        opts.summary.ledgerHits += 1;
        return {
          verdict: recorded.verdict as ContradictionVerdict['verdict'],
          direction: recorded.direction,
          reason: 'ledger: unchanged pair keeps its verdict',
          fresh: false,
        };
      }
    }

    // The deterministic arm first (issue C): a same-slot numeric conflict
    // with no update reading needs no model.
    const deterministic = deterministicContradiction(factView, candidateView);
    if (deterministic.conclusive && deterministic.decision.decision === 'conflict') {
      opts.summary.deterministicChecks += 1;
      const reason = `numeric conflict: ${deterministic.decision.aRaw} vs ${deterministic.decision.bRaw} in the same specification`;
      await this.ledger?.record(tx, fact.id, candidate.row.id, {
        ownerId: fact.ownerId,
        spaceId: fact.spaceId,
        family: 'contradiction',
        verdict: 'contradicts',
        similarity: candidate.similarity,
        promptVersion: DETERMINISTIC_QUANTITY_RULE,
        modelConfig: active.modelConfig,
        configVersion: RECONCILE_CONFIG_VERSION,
      });
      return { verdict: 'contradicts', direction: null, reason, fresh: false };
    }

    if (opts.budgetLeft <= 0) return null;
    opts.summary.contradictionChecks += 1;
    const verdict = await this.judge.judgeContradiction(factView, candidateView);
    await this.ledger?.record(tx, fact.id, candidate.row.id, {
      ownerId: fact.ownerId,
      spaceId: fact.spaceId,
      family: 'contradiction',
      verdict: verdict.verdict,
      direction: verdict.direction ?? null,
      similarity: candidate.similarity,
      promptVersion: active.promptVersion,
      modelConfig: active.modelConfig,
      configVersion: RECONCILE_CONFIG_VERSION,
    });
    return {
      verdict: verdict.verdict,
      direction: verdict.direction,
      reason: verdict.reason,
      fresh: true,
    };
  }

  /**
   * Findings settlement after a supersession closed one party (issue E,
   * docs/features/findings.md): judge the successor against each open
   * finding's counterpart — ledger first — and resolve, follow, or keep open.
   * Conservative: only a `compatible` verdict closes a finding.
   */
  private async settleFindingsAfterSupersession(
    tx: Tx,
    winner: MemoryRow,
    loser: MemoryRow,
    spans: Map<string, string | null>,
    log: PipelineLog,
  ): Promise<number> {
    const open = await this.reconciliation.openRelationsTouching(tx, loser.id);
    let resolved = 0;
    for (const relation of open) {
      const counterpartId =
        relation.aMemoryId === loser.id ? relation.bMemoryId : relation.aMemoryId;
      const counterpartRows = await this.memoryStore.getManyForPrincipal(
        ownerPrincipal(winner.ownerId, winner.spaceId),
        [counterpartId],
        { includeSensitive: true },
      );
      const counterpart = counterpartRows[0];
      if (!counterpart) {
        await this.reconciliation.keepOpen(tx, relation, 'counterpart unreadable at settlement');
        continue;
      }
      const judged = await this.contradictionVerdict(
        tx,
        winner,
        { row: counterpart, similarity: null },
        this.toView(winner, spans),
        spans,
        { budgetLeft: 1, rejudge: false, summary: emptySummary() },
      );
      if (judged?.verdict === 'compatible') {
        const revisionLink = await this.revisionLinkBetween(winner, loser);
        await this.reconciliation.resolveByRevision(tx, relation, {
          supersededId: loser.id,
          successorId: winner.id,
          sourceRevisionId: revisionLink,
        });
        resolved += 1;
        log(
          { stage: 'reconcile', relation: relation.id, resolved: 'revision' },
          'finding resolved by revision',
        );
      } else if (judged?.verdict === 'contradicts') {
        await this.reconciliation.followSuccessor(tx, relation, loser.id, winner.id);
        log(
          { stage: 'reconcile', relation: relation.id, follows: winner.id },
          'finding follows successor',
        );
      } else {
        await this.reconciliation.keepOpen(
          tx,
          relation,
          judged
            ? `successor verdict "${judged.verdict}" is not a clean resolution`
            : 'no verdict obtainable for the successor pair',
        );
      }
    }
    return resolved;
  }

  /** The source_revision id linking winner's source over loser's, if any. */
  private async revisionLinkBetween(winner: MemoryRow, loser: MemoryRow): Promise<string | null> {
    if (!this.revisions) return null;
    if (winner.sourceType === loser.sourceType && winner.sourceId === loser.sourceId) return null;
    const links = await this.revisions.forSource(ownerPrincipal(winner.ownerId, winner.spaceId), {
      sourceType: winner.sourceType,
      sourceId: winner.sourceId,
    });
    const link = links.find(
      (row) =>
        row.predecessorType === loser.sourceType &&
        row.predecessorId === loser.sourceId &&
        row.successorType === winner.sourceType &&
        row.successorId === winner.sourceId &&
        (row.status === 'auto' || row.status === 'confirmed' || row.status === 'manual'),
    );
    return link?.id ?? null;
  }

  /**
   * Budget policy (issue B): the budget spends on the most LIKELY conflicts,
   * not the first few by similarity. A pair whose quantities already compare
   * as a same-slot conflict outranks everything; then alias-matched subjects
   * (recorded identity), then similarity.
   */
  private rankByConflictLikelihood(candidates: Candidate[], fact: MemoryRow): Candidate[] {
    const score = (candidate: Candidate): number => {
      let value = candidate.similarity ?? 0.5;
      const quantities = compareQuantities(fact.content ?? '', candidate.row.content ?? '');
      if (quantities.decision === 'conflict') value += 1;
      return value;
    };
    return [...candidates]
      .map((candidate) => ({ candidate, score: score(candidate) }))
      .sort((x, y) => y.score - x.score)
      .map(({ candidate }) => candidate);
  }

  private async aliasIndexFor(ownerId: string, spaceId: string): Promise<EntityAliasIndex> {
    if (!this.aliases) return EMPTY_ALIAS_INDEX;
    const key = `${ownerId}:${spaceId}`;
    const cached = this.aliasCache.get(key);
    if (cached) return cached;
    const index = await this.aliases.indexForOwner(ownerId, spaceId);
    // Per-call staleness is fine: aliases change rarely and the next batch
    // reloads. Bounded: cleared once it holds more than a handful of owners.
    if (this.aliasCache.size > 16) this.aliasCache.clear();
    this.aliasCache.set(key, index);
    return index;
  }

  /**
   * Deterministic candidate generation (0010 ruling 6): gated vector search
   * narrowed to the owner's rows in the fact's scope, plus the entity path,
   * plus (V2.3 item 6.1) the subject path — rows sharing the fact's subject
   * entity through folding or a recorded alias, which is how cross-language
   * pairs are found at all. Zero model calls.
   */
  private async gatherCandidates(
    fact: MemoryRow,
    embedding: number[],
    /** The ids passed to this call. */
    batchIds: ReadonlySet<string>,
    exclude: 'same_batch' | 'same_source',
    aliasIndex: EntityAliasIndex,
  ): Promise<Candidate[]> {
    const principal = ownerPrincipal(fact.ownerId, fact.spaceId);
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

    // The subject path: expand the fact's subject through the alias set and
    // fetch rows anchored to ANY equivalent name. This is the only path that
    // can find a cross-language counterpart, whose embedding similarity and
    // raw trigram distance are both structurally unhelpful.
    const subjectNames = fact.subjectEntity
      ? [fact.subjectEntity, ...aliasIndex.expand(fact.subjectEntity)]
      : [];
    const subjectRows =
      subjectNames.length > 0
        ? await this.memoryStore.subjectSearch(principal, subjectNames, {
            ...readOpts,
            topK: CANDIDATE_TOP_K,
            scope: fact.scope as MemoryScope,
          })
        : [];

    const byId = new Map<string, MemoryRow>();
    for (const row of [...rows, ...entityRows, ...subjectRows]) byId.set(row.id, row);

    const candidates: Candidate[] = [];
    for (const row of byId.values()) {
      if (row.id === fact.id) continue;
      // The space constraint lives INSIDE every candidate query above (the
      // gate rides the fabricated principal), never in a post-filter: a
      // budget applied to a set that spanned two spaces would silently
      // starve the pairing that should have happened within one
      // (docs/features/spaces.md). A row from another space reaching this
      // loop therefore means the gate itself is broken, and the only honest
      // response is to stop, not to skim it off.
      if (row.spaceId !== fact.spaceId) {
        throw new Error(
          `reconciliation candidate ${row.id} crossed the space wall (fact ${fact.id}); ` +
            'the gated candidate reads can never return this, refusing to continue',
        );
      }
      if (exclude === 'same_batch' && batchIds.has(row.id)) continue;
      if (
        exclude === 'same_source' &&
        row.sourceType === fact.sourceType &&
        row.sourceId === fact.sourceId
      ) {
        continue;
      }
      if (row.ownerId !== fact.ownerId || row.scope !== fact.scope) continue;
      if (!eligibleStatuses.includes(row.status)) continue;
      // The subject path's SQL match is recall; precision is the canonical
      // check — a trigram hit that does not alias-match is not a candidate.
      if (
        !similarityById.has(row.id) &&
        !entityRows.some((r) => r.id === row.id) &&
        subjectMatchKind(fact, row, aliasIndex) === 'none'
      ) {
        continue;
      }
      candidates.push({ row, similarity: similarityById.get(row.id) ?? null });
    }
    // Best-similarity first; entity-only candidates follow the scored ones.
    return candidates.sort((x, y) => (y.similarity ?? -1) - (x.similarity ?? -1));
  }

  /** Cited source passages give the judge evidence, not just claims (spec §2 spirit). */
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
