import { readdir, readFile, access } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { ModelGateway } from '../model-gateway/index';
import { buildPairInput, TASK_CLOSURE_PROMPT, TASK_CONDITION_PROMPT } from './tasks.engine';
import type { TaskRow } from './persistence/tables';
import type { MemoryRow } from '../memory/index';
import { loadPrompt } from '../model-gateway/index';

/**
 * Task-judgment pair eval (decision 0013 ruling 3; F3-B): runs the REAL
 * judgment path (the versioned prompts through the gateway, the exact
 * buildPairInput the engine uses) over labeled task/fact pairs under
 * project/eval/golden/{lang}/{case-dir}/task-pair.json. Scores ACTIONS:
 *
 * - closure accuracy — false closures weighted ×2 (a wrongly closed task
 *   hides an obligation — the dedup false-merge mirror);
 * - condition accuracy — plain.
 */

export const taskPairSchema = z.object({
  case_id: z.string(),
  family: z.enum(['closure', 'condition']),
  expected: z.enum(['closes', 'no_close', 'satisfied', 'not_satisfied']),
  task: z.object({
    title: z.string().min(1),
    primary_person: z.string().nullable().default(null),
    entities: z.array(z.string()).default([]),
    condition_text: z.string().nullable().default(null),
    due: z.string().nullable().default(null),
  }),
  fact: z.object({
    content: z.string().min(1),
    entities: z.array(z.string()).default([]),
    captured_at: z.string().default('2026-07-05T09:00:00.000Z'),
  }),
  notes: z.string().optional(),
});
export type TaskPairCase = z.infer<typeof taskPairSchema>;

const closureSchema = z.object({
  verdict: z.enum(['closes', 'progresses', 'unrelated']),
  reason: z.string().min(1),
});
const conditionSchema = z.object({
  verdict: z.enum(['satisfied', 'not_satisfied', 'unrelated']),
  reason: z.string().min(1),
});

export interface TaskEvalMetrics {
  label: string;
  closurePairs: number;
  closureWeight: number;
  closureEarned: number;
  closureAccuracy: number;
  falseClosures: number;
  conditionPairs: number;
  conditionCorrect: number;
  conditionAccuracy: number;
}

export interface TaskEvalResult {
  perLanguage: TaskEvalMetrics[];
  aggregate: TaskEvalMetrics;
  pairCount: number;
  outcomes: { caseId: string; expected: string; verdict: string }[];
}

async function loadTaskPairs(goldenDir: string): Promise<{ lang: string; pair: TaskPairCase }[]> {
  const pairs: { lang: string; pair: TaskPairCase }[] = [];
  const langs = (await readdir(goldenDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const lang of langs) {
    const dirs = (await readdir(path.join(goldenDir, lang), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const dir of dirs) {
      const file = path.join(goldenDir, lang, dir, 'task-pair.json');
      try {
        await access(file);
      } catch {
        continue;
      }
      pairs.push({ lang, pair: taskPairSchema.parse(JSON.parse(await readFile(file, 'utf8'))) });
    }
  }
  return pairs;
}

function toTaskRow(pair: TaskPairCase): TaskRow {
  return {
    id: 'eval-task',
    ownerId: 'eval',
    scope: 'private',
    derivedFromMemoryId: 'eval-memory',
    title: pair.task.title,
    primaryPerson: pair.task.primary_person,
    entities: pair.task.entities,
    conditionText: pair.task.condition_text,
    conditionMet: false,
    conditionMetByMemoryId: null,
    due: pair.task.due ? new Date(pair.task.due) : null,
    status: pair.task.condition_text ? 'blocked_on_condition' : 'open',
    closedByMemoryId: null,
    dormant: false,
    fromUncertain: false,
    adopted: false,
    dueRemindedAt: null,
    dormantRemindedAt: null,
    createdAt: new Date(pair.fact.captured_at),
    updatedAt: new Date(pair.fact.captured_at),
  };
}

function toFactRow(pair: TaskPairCase): MemoryRow {
  return {
    id: 'eval-fact',
    ownerId: 'eval',
    scope: 'private',
    sourceType: 'user_note',
    sourceId: 'eval',
    status: 'active',
    sensitive: false,
    entities: pair.fact.entities,
    temporalUnresolved: [],
    subjectEntity: null,
    kind: 'fact',
    authoredByUser: null,
    validFrom: new Date(pair.fact.captured_at),
    validUntil: null,
    supersededBy: null,
    content: pair.fact.content,
    contentEmbeddingRef: null,
    embeddingModel: null,
    createdAt: new Date(pair.fact.captured_at),
    updatedAt: new Date(pair.fact.captured_at),
  } as MemoryRow;
}

function emptyMetrics(label: string): TaskEvalMetrics {
  return {
    label,
    closurePairs: 0,
    closureWeight: 0,
    closureEarned: 0,
    closureAccuracy: 1,
    falseClosures: 0,
    conditionPairs: 0,
    conditionCorrect: 0,
    conditionAccuracy: 1,
  };
}

function finalize(m: TaskEvalMetrics): TaskEvalMetrics {
  m.closureAccuracy = m.closureWeight === 0 ? 1 : m.closureEarned / m.closureWeight;
  m.conditionAccuracy = m.conditionPairs === 0 ? 1 : m.conditionCorrect / m.conditionPairs;
  return m;
}

export async function runTaskEval(options: {
  gateway: ModelGateway;
  goldenDir: string;
  log?: (message: string) => void;
}): Promise<TaskEvalResult> {
  const log = options.log ?? (() => undefined);
  const pairs = await loadTaskPairs(options.goldenDir);
  const closurePrompt = await loadPrompt(TASK_CLOSURE_PROMPT.family, TASK_CLOSURE_PROMPT.version);
  const conditionPrompt = await loadPrompt(
    TASK_CONDITION_PROMPT.family,
    TASK_CONDITION_PROMPT.version,
  );

  const byLang = new Map<string, TaskEvalMetrics>();
  const aggregate = emptyMetrics('aggregate');
  const outcomes: TaskEvalResult['outcomes'] = [];

  for (const { lang, pair } of pairs) {
    const metrics = byLang.get(lang) ?? emptyMetrics(lang);
    byLang.set(lang, metrics);
    const input = buildPairInput(toTaskRow(pair), toFactRow(pair));

    let verdict: string;
    try {
      if (pair.family === 'closure') {
        verdict = (
          await options.gateway.extractStructured(closureSchema, {
            system: closurePrompt.content,
            input,
          })
        ).verdict;
      } else {
        verdict = (
          await options.gateway.extractStructured(conditionSchema, {
            system: conditionPrompt.content,
            input,
          })
        ).verdict;
      }
    } catch (error) {
      log(`${pair.case_id}: PAIR FAILED (${error instanceof Error ? error.message : error})`);
      verdict = 'error';
    }
    outcomes.push({ caseId: pair.case_id, expected: pair.expected, verdict });
    log(`${pair.case_id}: expected ${pair.expected} -> ${verdict}`);

    for (const m of [metrics, aggregate]) {
      if (pair.family === 'closure') {
        m.closurePairs += 1;
        // Must-not-close pairs weigh double (a false close hides an obligation).
        const weight = pair.expected === 'no_close' ? 2 : 1;
        m.closureWeight += weight;
        const closed = verdict === 'closes';
        const correct = pair.expected === 'closes' ? closed : !closed;
        if (correct) m.closureEarned += weight;
        else if (pair.expected === 'no_close') m.falseClosures += 1;
      } else {
        m.conditionPairs += 1;
        const satisfied = verdict === 'satisfied';
        const correct = pair.expected === 'satisfied' ? satisfied : !satisfied;
        if (correct) m.conditionCorrect += 1;
      }
    }
  }

  return {
    perLanguage: [...byLang.values()].map(finalize).sort((a, b) => a.label.localeCompare(b.label)),
    aggregate: finalize(aggregate),
    pairCount: pairs.length,
    outcomes,
  };
}
