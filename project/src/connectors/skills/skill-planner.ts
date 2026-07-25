import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@cogeto/shared';
import { loadPrompt, ModelGateway } from '../../model-gateway/index';
import type { PromptArtifact } from '../../model-gateway/index';
import { RetrievalService } from '../../retrieval/index';
import type { RetrieveOptions, RetrievedMemory } from '../../retrieval/index';
import type { MemoryRow } from '../../memory/index';
import { ResearchService } from '../research.service';
import { SkillRunService } from './skill-run.service';
import { getSkill } from './skill-registry';
import type { SkillRunRow } from '../persistence/tables';

export const SKILL_PLAN_PROMPT = { family: 'skill_plan', version: 'v0001' };

/** The plan's hard bounds (decision 0059 ruling 5): the prompt asks for 3–6;
 * the code enforces the ceiling whatever the model returns. */
export const MAX_PLAN_QUERIES = 6;

/** How much memory context the plan prompt sees (bounded input, house rule). */
const PLAN_MEMORY_FACTS = 20;
const PLAN_OPEN_LOOPS = 8;
const FACT_EXCERPT_CHARS = 240;

const planSchema = z.object({
  queries: z
    .array(
      z.object({
        query: z.string().min(1),
        angle: z.enum(['identity', 'news', 'context']).catch('context'),
        reason: z.string().min(1),
      }),
    )
    .min(1),
});

/** A pre-built rewrite that makes retrieval deterministic (no rewriter call). */
type PrebuiltRewrite = NonNullable<RetrieveOptions['rewrite']>;

const profileRewrite = (subject: string): PrebuiltRewrite => ({
  query: `tell me about ${subject}`,
  entities: [subject],
  temporal: null,
  openLoops: null,
  emailReply: null,
  questionClass: 'personal',
});

const openLoopsRewrite = (subject: string): PrebuiltRewrite => ({
  query: subject,
  entities: [subject],
  temporal: null,
  openLoops: { entity: subject },
  emailReply: null,
  questionClass: 'personal',
});

export interface SkillProposal {
  status: 'created';
  run: SkillRunRow;
}

export interface SkillAmbiguity {
  status: 'ambiguous';
  candidates: string[];
}

/**
 * Planning (decision 0059 ruling 5): the propose-request half of a skill run —
 * disambiguate the subject, gather what memory knows (entity-profile mode),
 * plan the minimised queries, and stop at the gate (`awaiting_approval`).
 * Composed app-only (needs RetrievalService), the ResearchChatModule shape.
 * Nothing here sends anything anywhere.
 */
@Injectable()
export class SkillPlanner {
  private readonly log = new Logger(SkillPlanner.name);
  private prompt?: PromptArtifact;

  constructor(
    private readonly retrieval: RetrievalService,
    private readonly research: ResearchService,
    private readonly runs: SkillRunService,
    private readonly gateway: ModelGateway,
  ) {}

  async propose(
    principal: Principal,
    skillId: string,
    subject: string,
  ): Promise<SkillProposal | SkillAmbiguity> {
    const skill = getSkill(skillId);
    if (!skill) throw new NotFoundException(`unknown skill '${skillId}'`);
    const cleanSubject = subject.trim();

    // 1. Gather what memory knows (entity-profile mode, scope-gated as
    // always) plus the open loops involving the subject. Deterministic:
    // pre-built rewrites, no rewriter call.
    const [profile, loops] = await Promise.all([
      this.retrieval.retrieve(principal, `tell me about ${cleanSubject}`, {
        rewrite: profileRewrite(cleanSubject),
      }),
      this.retrieval.retrieve(principal, cleanSubject, {
        rewrite: openLoopsRewrite(cleanSubject),
      }),
    ]);

    // 2. Ambiguity asks BEFORE planning (issue #262): a bare token matching
    // several distinct known entities creates nothing and lists them.
    const candidates = ambiguousCandidates(
      cleanSubject,
      profile.memories.map((m) => m.memory),
    );
    if (candidates.length > 0) return { status: 'ambiguous', candidates };

    // 3. The run + its step log exist from here; both planning steps
    // checkpoint their outcome so the finished log reads complete.
    const run = await this.runs.createRun(principal, skill, cleanSubject);
    const profileIds = profile.memories.map((m) => m.memory.id);
    const loopIds = (loops.tasks ?? []).map((t) => t.derivedFromMemoryId);
    await this.runs.claimStep(run.id, 'gather_memory');
    await this.runs.patchStep(run.id, 'gather_memory', {
      inputsSummary: `Entity profile for "${cleanSubject}"`,
    });
    await this.runs.finishStep(run.id, 'gather_memory', {
      status: 'completed',
      outputsSummary:
        profileIds.length === 0
          ? 'Nothing on record about this subject yet'
          : `${profileIds.length} remembered ${profileIds.length === 1 ? 'fact' : 'facts'}, ${loopIds.length} open ${loopIds.length === 1 ? 'loop' : 'loops'}`,
      links: {
        memoryIds: profileIds,
        loopMemoryIds: loopIds.filter((id) => !profileIds.includes(id)),
        counts: { facts: profileIds.length, openLoops: loopIds.length },
      },
    });

    // 4. Plan the queries (one pipeline-tier call, minimisation built in) and
    // record each as an ordinary proposed research run tagged with this skill
    // run. NOTHING is sent — the gate owns everything after.
    await this.runs.claimStep(run.id, 'plan_searches');
    const planned = await this.planQueries(cleanSubject, profile.memories, loops);
    const runIds: string[] = [];
    for (const query of planned) {
      const row = await this.research.proposeForSkill(principal, run.id, {
        intent: `${skill.name}: ${cleanSubject}`,
        query: query.query,
        reason: query.reason,
      });
      runIds.push(row.id);
    }
    await this.runs.finishStep(run.id, 'plan_searches', {
      status: 'completed',
      outputsSummary: `${runIds.length} ${runIds.length === 1 ? 'search' : 'searches'} proposed — awaiting your approval`,
      links: { researchRunIds: runIds, counts: { queries: runIds.length } },
    });
    const updated = await this.runs.transition(run.id, 'planning', 'awaiting_approval');
    return { status: 'created', run: updated ?? run };
  }

  /**
   * One `skill_plan` call; on any model failure, deterministic fallback
   * queries with an honest reason (the 0044 fail-open rule: the failure mode
   * is "review it yourself", never "silently sent").
   */
  private async planQueries(
    subject: string,
    profile: RetrievedMemory[],
    loops: { memories: RetrievedMemory[] },
  ): Promise<{ query: string; reason: string }[]> {
    const factLines = profile
      .slice(0, PLAN_MEMORY_FACTS)
      .map((m) => `- ${(m.memory.content ?? '').slice(0, FACT_EXCERPT_CHARS)}`)
      .filter((line) => line.length > 2);
    const loopLines = loops.memories
      .slice(0, PLAN_OPEN_LOOPS)
      .map((m) => `- ${(m.memory.content ?? '').slice(0, FACT_EXCERPT_CHARS)}`)
      .filter((line) => line.length > 2);
    try {
      this.prompt ??= await loadPrompt(SKILL_PLAN_PROMPT.family, SKILL_PLAN_PROMPT.version);
      const output = await this.gateway.extractStructured(planSchema, {
        system: this.prompt.content,
        input:
          `SUBJECT:\n${subject}\n\n` +
          `WHAT MEMORY KNOWS:\n${factLines.join('\n') || '(nothing on record)'}\n\n` +
          `OPEN LOOPS:\n${loopLines.join('\n') || '(none)'}`,
        // tier omitted → the pipeline tier, never answer.
      });
      const queries = output.queries.slice(0, MAX_PLAN_QUERIES);
      if (queries.length > 0) return queries;
    } catch (error) {
      this.log.warn(
        `skill_plan_failed (deterministic fallback): ${error instanceof Error ? error.message : 'error'}`,
      );
    }
    return fallbackQueries(subject);
  }
}

/** The deterministic plan when the planning model is unavailable. */
export function fallbackQueries(subject: string): { query: string; reason: string }[] {
  const reason = 'planning was unavailable — review this query yourself before approving';
  return [
    { query: subject, reason },
    { query: `${subject} news`, reason },
  ];
}

/**
 * Distinct known entities a bare subject could mean (issue #262): stored
 * entity names that contain the subject as a whole word but are not the
 * subject itself. Two or more → ask, create nothing. An exact stored match
 * means the subject is already precise.
 */
export function ambiguousCandidates(subject: string, rows: MemoryRow[]): string[] {
  const needle = subject.trim().toLowerCase();
  if (!needle) return [];
  const names = new Set<string>();
  let exact = false;
  for (const row of rows) {
    const candidates = [row.subjectEntity, ...row.entities].filter(
      (name): name is string => typeof name === 'string' && name.length > 0,
    );
    for (const name of candidates) {
      const lower = name.toLowerCase();
      if (lower === needle) {
        exact = true;
        continue;
      }
      const word = new RegExp(
        `(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}([^\\p{L}\\p{N}]|$)`,
        'iu',
      );
      if (word.test(lower)) names.add(name);
    }
  }
  if (exact || names.size < 2) return [];
  return [...names].sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
