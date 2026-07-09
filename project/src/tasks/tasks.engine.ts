import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Principal } from '@cogeto/shared';
import { DRIZZLE, writeAudit } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import { MemoryStore } from '../memory/index';
import type { MemoryRow, SourceType } from '../memory/index';
import { clearDormantFlag, listOpenDormantFlags } from '../ingestion/index';
import { loadPrompt, ModelGateway } from '../model-gateway/index';
import type { PromptArtifact } from '../model-gateway/index';
import { task } from './persistence/tables';
import type { TaskRow } from './persistence/tables';
import { gateForeignTasks } from './task-visibility';
import { REMINDER_DUE_SOON_HORIZON_HOURS } from './reminders-config';

/**
 * The task-derivation engine (decision 0013; glossary: Task, Open loops) —
 * the second half of the day-one job. THE module rule: tasks reads memory
 * through its public interface and NEVER mutates it; condition satisfaction
 * and closure are observations recorded on task rows, not transitions on
 * memories.
 *
 * Derivation is deterministic from structure (kind commitment/open_loop →
 * exactly one task, UNIQUE per deriving memory — idempotent by constraint).
 * Condition/closure are model judgments over deterministic candidate pairs,
 * biased hard to no-action: a wrongly closed task hides an obligation.
 */

export const TASK_CONDITION_PROMPT = { family: 'task_condition', version: 'v0001' } as const;
export const TASK_CLOSURE_PROMPT = { family: 'task_closure', version: 'v0001' } as const;
export const TASK_PROMPTS = [TASK_CONDITION_PROMPT, TASK_CLOSURE_PROMPT] as const;

/**
 * The reminders pass runs on the EXISTING graphile cron (F3 handoff §2): ONE
 * new crontab line + task, no second scheduler. 03:40 — after the 03:30
 * dreaming cycle, so the dormancy sync it depends on has already run.
 */
export const TASKS_REMINDERS_JOB_TYPE = 'tasks_reminders';
export const TASKS_REMINDERS_CRONTAB = `40 3 * * * ${TASKS_REMINDERS_JOB_TYPE}`;

const closureVerdictSchema = z.object({
  verdict: z.enum(['closes', 'progresses', 'unrelated']),
  reason: z.string().min(1),
});
const conditionVerdictSchema = z.object({
  verdict: z.enum(['satisfied', 'not_satisfied', 'unrelated']),
  reason: z.string().min(1),
});

/** Kinds that derive tasks (0013 ruling 2). */
const DERIVING_KINDS = ['commitment', 'open_loop'] as const;
/** Max judged tasks per incoming fact per run — mirrors F2's check cap. */
const MAX_TASK_CHECKS = 3;
/** Candidate pool cap per owner. */
const OPEN_TASK_POOL = 200;

export interface TaskEngineReport {
  derived: number;
  repointed: number;
  dismissedDuplicates: number;
  closed: number;
  conditionsMet: number;
  dormantSynced: number;
}

export interface ReminderReport {
  dueRaised: number;
  dormantRaised: number;
  dormantCleared: number;
}

export interface TaskListFilters {
  statuses?: TaskRow['status'][];
  entity?: string;
  includeSettled?: boolean;
}

const norm = (name: string) => name.trim().toLowerCase();

@Injectable()
export class TasksEngine {
  private conditionPrompt?: PromptArtifact;
  private closurePrompt?: PromptArtifact;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly memoryStore: MemoryStore,
    private readonly gateway: ModelGateway,
  ) {}

  // ── Engine entrypoints (worker jobs) ────────────────────────────────────────

  /**
   * One source's post-admission pass: derive tasks from its commitment /
   * open-loop memories, then judge its new facts against the owner's open
   * tasks (closure first, then condition), then maintenance. Runs inside the
   * job's idempotency transaction; every action re-checks state under locks.
   */
  async processSource(tx: Tx, sourceType: string, sourceId: string): Promise<TaskEngineReport> {
    const report = emptyReport();
    const rows = await this.memoryStore.listBySourceSystem(sourceType as SourceType, sourceId);
    if (rows.length === 0) return report;

    for (const row of rows) {
      if (this.derivable(row)) {
        report.derived += await this.deriveTask(tx, row);
      }
    }
    for (const row of rows) {
      if (row.status !== 'active') continue; // only verified facts settle tasks
      const { closed, conditionsMet } = await this.judgeFact(tx, row);
      report.closed += closed;
      report.conditionsMet += conditionsMet;
    }
    await this.maintain(tx, report, [...new Set(rows.map((r) => r.ownerId))]);
    return report;
  }

  /**
   * The idempotent backfill (0013 ruling 2): historical commitments gain
   * tasks; UNIQUE makes re-runs no-ops. Deliberately model-free — judgments
   * ride only on newly admitted facts.
   */
  async backfill(log: (message: string) => void = () => undefined): Promise<TaskEngineReport> {
    const report = emptyReport();
    const rows = await this.memoryStore.listByKindsSystem(
      [...DERIVING_KINDS],
      ['active', 'uncertain'],
    );
    await this.db.transaction(async (tx) => {
      for (const row of rows) {
        report.derived += await this.deriveTask(tx, row);
      }
      await this.maintain(tx, report, [...new Set(rows.map((r) => r.ownerId))]);
    });
    log(
      `tasks backfill: ${report.derived} derived, ${report.repointed} repointed, ` +
        `${report.dormantSynced} dormant synced`,
    );
    return report;
  }

  /**
   * The reminders pass (F3 handoff §2) — a graphile-cron job, NOT a new
   * scheduler. Evaluates every open/blocked task against the due horizon and
   * the dormancy flag and stamps a pending reminder ONCE per window:
   *
   *   - due-based: `due` within the horizon (overdue tasks are already inside
   *     it) and no pending due reminder ⇒ stamp `due_reminded_at`.
   *   - dormant-based: `dormant` set and no pending dormant reminder ⇒ stamp;
   *     `dormant` cleared but a stamp lingers ⇒ clear it (dormancy resolved).
   *
   * Idempotent per task per window by the "stamp only when NULL" rule: a
   * re-delivered pass finds every stamp already set and changes nothing. The
   * digest renders tasks carrying a pending stamp; close/dismiss clears both
   * (see `settle` and `userOp`). Deliberately does NOT touch `updated_at` — a
   * reminder is not a task edit, and the digest's "newly unblocked" line keys
   * off `updated_at`.
   */
  async runReminders(log: (message: string) => void = () => undefined): Promise<ReminderReport> {
    const report: ReminderReport = { dueRaised: 0, dormantRaised: 0, dormantCleared: 0 };
    const now = new Date();
    const horizon = new Date(now.getTime() + REMINDER_DUE_SOON_HORIZON_HOURS * 3600 * 1000);
    await this.db.transaction(async (tx) => {
      const open = await tx
        .select()
        .from(task)
        .where(inArray(task.status, ['open', 'blocked_on_condition']))
        .for('update');
      for (const t of open) {
        const patch: Partial<typeof task.$inferInsert> = {};
        if (t.due && t.due <= horizon && t.dueRemindedAt === null) {
          patch.dueRemindedAt = now;
          report.dueRaised += 1;
        }
        if (t.dormant && t.dormantRemindedAt === null) {
          patch.dormantRemindedAt = now;
          report.dormantRaised += 1;
        } else if (!t.dormant && t.dormantRemindedAt !== null) {
          patch.dormantRemindedAt = null;
          report.dormantCleared += 1;
        }
        if (Object.keys(patch).length > 0) {
          await tx.update(task).set(patch).where(eq(task.id, t.id));
        }
      }
    });
    log(
      `tasks reminders: ${report.dueRaised} due raised, ` +
        `${report.dormantRaised} dormant raised, ${report.dormantCleared} cleared`,
    );
    return report;
  }

  // ── Derivation (deterministic; 0013 ruling 2) ───────────────────────────────

  private derivable(row: MemoryRow): boolean {
    return (
      row.kind !== null &&
      (DERIVING_KINDS as readonly string[]).includes(row.kind) &&
      (row.status === 'active' || row.status === 'uncertain')
    );
  }

  /** Inserts the task; the UNIQUE deriving-memory constraint is the idempotency. */
  private async deriveTask(tx: Tx, row: MemoryRow): Promise<number> {
    const conditionText = await this.conditionOf(row);
    const inserted = await tx
      .insert(task)
      .values({
        ownerId: row.ownerId,
        scope: row.scope,
        derivedFromMemoryId: row.id,
        // v1 title = the memory content verbatim: structure suffices, and
        // derivation stays fully deterministic (0013 ruling 2 allows a
        // cosmetic rephrase call later without touching WHETHER).
        title: (row.content ?? '').trim() || '(untitled commitment)',
        primaryPerson: row.subjectEntity ?? row.entities[0] ?? null,
        entities: row.entities,
        conditionText,
        due: row.validUntil,
        status: conditionText ? 'blocked_on_condition' : 'open',
        fromUncertain: row.status === 'uncertain',
      })
      .onConflictDoNothing({ target: task.derivedFromMemoryId })
      .returning({ id: task.id });
    if (inserted.length === 0) return 0;
    await writeAudit(tx, {
      actor: 'tasks_engine',
      action: 'task.derived',
      entityType: 'task',
      entityId: inserted[0]!.id,
      detail: { memoryId: row.id, kind: row.kind, blocked: conditionText !== null },
    });
    return 1;
  }

  /** The extractor's condition lives in the verification-era fact; the memory
   * row does not carry it as a column — the temporal_unresolved pattern's
   * sibling. v1 heuristic: a leading "after/once/when/nakon što/kad" clause in
   * the content is the condition; otherwise none. Deterministic, no model. */
  private async conditionOf(row: MemoryRow): Promise<string | null> {
    const text = row.content ?? '';
    const match =
      /\b(?:after|once|when|as soon as|nakon što|kad(?:a)?|čim)\b\s+([^.;]{4,120})/i.exec(text);
    return match ? match[0].trim() : null;
  }

  // ── Judgments (model-confirmed; 0013 ruling 3) ──────────────────────────────

  private async judgeFact(
    tx: Tx,
    fact: MemoryRow,
  ): Promise<{ closed: number; conditionsMet: number }> {
    const result = { closed: 0, conditionsMet: 0 };
    const candidates = await this.candidateTasks(fact);
    for (const candidate of candidates.slice(0, MAX_TASK_CHECKS)) {
      // Closure first: a fulfilled task needs no unblocking (0013 ruling 3).
      const closure = await this.gateway.extractStructured(closureVerdictSchema, {
        system: (await this.getClosurePrompt()).content,
        input: buildPairInput(candidate, fact),
      });
      if (closure.verdict === 'closes') {
        if (await this.settle(tx, candidate.id, fact, 'done', closure.reason)) {
          result.closed += 1;
        }
        continue;
      }
      // `progresses` and `unrelated` change nothing — the no-action bias.
      if (candidate.status === 'blocked_on_condition' && candidate.conditionText) {
        const condition = await this.gateway.extractStructured(conditionVerdictSchema, {
          system: (await this.getConditionPrompt()).content,
          input: buildPairInput(candidate, fact),
        });
        if (condition.verdict === 'satisfied') {
          if (await this.unblock(tx, candidate.id, fact, condition.reason)) {
            result.conditionsMet += 1;
          }
        }
      }
    }
    return result;
  }

  /** Deterministic candidates: the owner's open tasks sharing an entity or
   * the primary person with the fact; never the fact's own task. */
  private async candidateTasks(fact: MemoryRow): Promise<TaskRow[]> {
    const pool = await this.db
      .select()
      .from(task)
      .where(
        and(eq(task.ownerId, fact.ownerId), inArray(task.status, ['open', 'blocked_on_condition'])),
      )
      .orderBy(desc(task.updatedAt))
      .limit(OPEN_TASK_POOL);
    const factNames = new Set(fact.entities.map(norm));
    if (fact.subjectEntity) factNames.add(norm(fact.subjectEntity));
    return pool.filter(
      (t) =>
        t.derivedFromMemoryId !== fact.id &&
        (t.entities.some((e) => factNames.has(norm(e))) ||
          (t.primaryPerson !== null && factNames.has(norm(t.primaryPerson)))),
    );
  }

  /** done via closure — re-checked under lock; settled tasks are skipped. */
  private async settle(
    tx: Tx,
    taskId: string,
    byFact: MemoryRow,
    to: 'done',
    reason: string,
  ): Promise<boolean> {
    const rows = await tx.select().from(task).where(eq(task.id, taskId)).for('update');
    const current = rows[0];
    if (!current || (current.status !== 'open' && current.status !== 'blocked_on_condition')) {
      return false; // already settled — idempotent under re-delivery
    }
    await tx
      .update(task)
      .set({
        status: to,
        closedByMemoryId: byFact.id,
        // A closed task carries no pending reminders (F3 handoff §2).
        dueRemindedAt: null,
        dormantRemindedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(task.id, taskId));
    await writeAudit(tx, {
      actor: 'tasks_engine',
      action: 'task.closed',
      entityType: 'task',
      entityId: taskId,
      detail: { byMemoryId: byFact.id, reason },
    });
    // Fulfilled → its dormant flag is done too (F2 handoff §3).
    await clearDormantFlag(this.db, current.derivedFromMemoryId);
    return true;
  }

  private async unblock(
    tx: Tx,
    taskId: string,
    byFact: MemoryRow,
    reason: string,
  ): Promise<boolean> {
    const rows = await tx.select().from(task).where(eq(task.id, taskId)).for('update');
    const current = rows[0];
    if (!current || current.status !== 'blocked_on_condition' || current.conditionMet) return false;
    await tx
      .update(task)
      .set({
        conditionMet: true,
        conditionMetByMemoryId: byFact.id,
        status: 'open',
        updatedAt: new Date(),
      })
      .where(eq(task.id, taskId));
    await writeAudit(tx, {
      actor: 'tasks_engine',
      action: 'task.condition_met',
      entityType: 'task',
      entityId: taskId,
      detail: { byMemoryId: byFact.id, reason },
    });
    return true;
  }

  // ── Maintenance: re-pointing and dormancy (0013 rulings 1, 5) ───────────────

  private async maintain(tx: Tx, report: TaskEngineReport, ownerIds: string[]): Promise<void> {
    if (ownerIds.length === 0) return;
    const open = await tx
      .select()
      .from(task)
      .where(
        and(
          inArray(task.ownerId, ownerIds),
          inArray(task.status, ['open', 'blocked_on_condition']),
        ),
      )
      .limit(OPEN_TASK_POOL);
    if (open.length === 0) return;

    const memories = new Map(
      (await this.memoryStore.getManySystem(open.map((t) => t.derivedFromMemoryId))).map((m) => [
        m.id,
        m,
      ]),
    );

    for (const t of open) {
      const start = memories.get(t.derivedFromMemoryId);
      if (!start) continue; // FK would have cascaded; defensive
      // Follow the supersession chain to its head (0013 ruling 1).
      let head: MemoryRow = start;
      let hops = 0;
      while (head.supersededBy && hops < 20) {
        const next: MemoryRow | undefined = (
          await this.memoryStore.getManySystem([head.supersededBy])
        )[0];
        if (!next) break;
        head = next;
        hops += 1;
      }
      if (head.id !== t.derivedFromMemoryId) {
        const headTask = await tx
          .select({ id: task.id })
          .from(task)
          .where(eq(task.derivedFromMemoryId, head.id));
        if (headTask.length === 0) {
          await tx
            .update(task)
            .set({
              derivedFromMemoryId: head.id,
              title: (head.content ?? '').trim() || t.title,
              entities: head.entities,
              primaryPerson: head.subjectEntity ?? head.entities[0] ?? t.primaryPerson,
              due: head.validUntil ?? t.due,
              fromUncertain: head.status === 'uncertain',
              updatedAt: new Date(),
            })
            .where(eq(task.id, t.id));
          report.repointed += 1;
          await writeAudit(tx, {
            actor: 'tasks_engine',
            action: 'task.repointed',
            entityType: 'task',
            entityId: t.id,
            detail: { from: t.derivedFromMemoryId, to: head.id },
          });
        } else {
          // The head already carries its own task: same obligation met through
          // a merge — the duplicate is dismissed, the obligation survives once.
          await tx
            .update(task)
            .set({
              status: 'dismissed',
              dueRemindedAt: null,
              dormantRemindedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(task.id, t.id));
          report.dismissedDuplicates += 1;
          await writeAudit(tx, {
            actor: 'tasks_engine',
            action: 'task.dismissed',
            entityType: 'task',
            entityId: t.id,
            detail: { reason: 'superseded_duplicate', head: head.id },
          });
        }
      } else if (t.fromUncertain && head.status === 'active') {
        await tx
          .update(task)
          .set({ fromUncertain: false, updatedAt: new Date() })
          .where(eq(task.id, t.id));
      }
    }

    // Dormancy sync (0013 ruling 5): task.dormant mirrors the open flags.
    const flagged = new Set((await listOpenDormantFlags(this.db)).map((f) => f.memoryId));
    for (const t of open) {
      const shouldBeDormant = flagged.has(t.derivedFromMemoryId);
      if (t.dormant !== shouldBeDormant) {
        await tx
          .update(task)
          .set({ dormant: shouldBeDormant, updatedAt: new Date() })
          .where(eq(task.id, t.id));
        report.dormantSynced += 1;
      }
    }
  }

  // ── User operations (audited; 0013 ruling 4) — the O2 UI's contract ─────────

  async reopen(principal: Principal, taskId: string): Promise<TaskRow> {
    return this.userOp(principal, taskId, ['done', 'dismissed'], (current) => ({
      status: current.conditionText && !current.conditionMet ? 'blocked_on_condition' : 'open',
      closedByMemoryId: null,
    }));
  }

  async dismiss(principal: Principal, taskId: string): Promise<TaskRow> {
    const row = await this.userOp(principal, taskId, ['open', 'blocked_on_condition'], () => ({
      status: 'dismissed',
    }));
    await clearDormantFlag(this.db, row.derivedFromMemoryId);
    return row;
  }

  async complete(principal: Principal, taskId: string): Promise<TaskRow> {
    const row = await this.userOp(principal, taskId, ['open', 'blocked_on_condition'], () => ({
      status: 'done',
    }));
    await clearDormantFlag(this.db, row.derivedFromMemoryId);
    return row;
  }

  private async userOp(
    principal: Principal,
    taskId: string,
    legalFrom: TaskRow['status'][],
    change: (current: TaskRow) => Partial<typeof task.$inferInsert>,
  ): Promise<TaskRow> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(task).where(eq(task.id, taskId)).for('update');
      const current = rows[0];
      if (!current || current.ownerId !== principal.userId) {
        throw new NotFoundException(`task ${taskId} not found`);
      }
      const patch = change(current);
      if (current.status === patch.status) return current; // idempotent no-op
      if (!legalFrom.includes(current.status)) {
        throw new BadRequestException(
          `cannot ${String(patch.status)} a task that is ${current.status}`,
        );
      }
      const [updated] = await tx
        .update(task)
        // Every user transition clears pending reminders: close/dismiss retire
        // them; reopen resets so the next pass re-raises against fresh state
        // (F3 handoff §2 — reminders clear when the task closes).
        .set({ ...patch, dueRemindedAt: null, dormantRemindedAt: null, updatedAt: new Date() })
        .where(eq(task.id, taskId))
        .returning();
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: `task.${String(patch.status)}`,
        entityType: 'task',
        entityId: taskId,
        detail: { from: current.status },
      });
      return updated as TaskRow;
    });
  }

  // ── Reads (owner-scoped; the answer path and the debug panel) ───────────────

  async listForPrincipal(principal: Principal, filters: TaskListFilters = {}): Promise<TaskRow[]> {
    const statuses =
      filters.statuses ??
      (filters.includeSettled
        ? (['open', 'blocked_on_condition', 'done', 'dismissed'] as TaskRow['status'][])
        : (['open', 'blocked_on_condition'] as TaskRow['status'][]));
    // Candidates: the caller's own tasks plus every shared-scope task (F3
    // handoff §5 — shared tasks are visible org-wide). Foreign shared tasks are
    // then gated through their deriving memory, which enforces scope + org +
    // sensitive; cross-org and private-of-others never survive.
    const rows = await this.db
      .select()
      .from(task)
      .where(
        and(
          or(eq(task.ownerId, principal.userId), eq(task.scope, 'shared')),
          inArray(task.status, statuses),
        ),
      )
      .orderBy(sql`${task.due} ASC NULLS LAST`, desc(task.updatedAt))
      .limit(OPEN_TASK_POOL);
    const visible = await gateForeignTasks(this.memoryStore, principal, rows);
    if (!filters.entity?.trim()) return visible;
    const wanted = norm(filters.entity);
    return visible.filter(
      (t) =>
        t.entities.some((e) => norm(e).includes(wanted)) ||
        (t.primaryPerson !== null && norm(t.primaryPerson).includes(wanted)),
    );
  }

  /**
   * The nav-badge count (F3 handoff §4): open + blocked, gated to the Principal
   * — the caller's OWN workload, not the org-wide shared view. Mirrors the
   * Review badge (your queue, not everyone's).
   */
  async countOpenForPrincipal(principal: Principal): Promise<number> {
    const rows = await this.db
      .select({ id: task.id })
      .from(task)
      .where(
        and(
          eq(task.ownerId, principal.userId),
          inArray(task.status, ['open', 'blocked_on_condition']),
        ),
      );
    return rows.length;
  }

  private async getConditionPrompt(): Promise<PromptArtifact> {
    this.conditionPrompt ??= await loadPrompt(
      TASK_CONDITION_PROMPT.family,
      TASK_CONDITION_PROMPT.version,
    );
    return this.conditionPrompt;
  }
  private async getClosurePrompt(): Promise<PromptArtifact> {
    this.closurePrompt ??= await loadPrompt(
      TASK_CLOSURE_PROMPT.family,
      TASK_CLOSURE_PROMPT.version,
    );
    return this.closurePrompt;
  }
}

function emptyReport(): TaskEngineReport {
  return {
    derived: 0,
    repointed: 0,
    dismissedDuplicates: 0,
    closed: 0,
    conditionsMet: 0,
    dormantSynced: 0,
  };
}

/** TASK vs NEW FACT blocks for both judgment prompts. */
export function buildPairInput(taskRow: TaskRow, fact: MemoryRow): string {
  const lines = [
    'TASK:',
    `title: ${taskRow.title}`,
    `person: ${taskRow.primaryPerson ?? 'unknown'}`,
    `status: ${taskRow.status}`,
  ];
  if (taskRow.conditionText) lines.push(`waiting on: ${taskRow.conditionText}`);
  if (taskRow.due) lines.push(`due: ${taskRow.due.toISOString().slice(0, 10)}`);
  lines.push(
    '',
    'NEW FACT:',
    `claim: ${fact.content ?? ''}`,
    `captured: ${fact.createdAt.toISOString().slice(0, 10)}`,
    `entities: ${fact.entities.length > 0 ? fact.entities.join(', ') : '(none)'}`,
  );
  return lines.join('\n');
}
