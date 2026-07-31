import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Principal, ResearchCitationDto, SkillStepLinks } from '@cogeto/shared';
import {
  buildContextBlock,
  DEFAULT_INSTANCE_TIMEZONE,
  DRIZZLE,
  EMPTY_USER_CONTEXT,
  INSTANCE_TIMEZONE,
  RESEARCH_QUOTA,
  UserContextService,
  withTransactionalEnqueue,
  writeAudit,
} from '../../infrastructure/index';
import type { Db, ResearchQuota } from '../../infrastructure/index';
import { MemoryStore } from '../../memory/index';
import type { MemoryRow } from '../../memory/index';
import {
  fenceUntrusted,
  loadPrompt,
  ModelGateway,
  untrustedBoundary,
} from '../../model-gateway/index';
import type { PromptArtifact } from '../../model-gateway/index';
import { ResearchService } from '../research.service';
import { skillRun } from '../persistence/tables';
import type { SkillRunRow, WebPageRow } from '../persistence/tables';
import { selectPagesForSubject } from './page-select';
import { SKILL_ADVANCE_JOB_TYPE, SkillRunService } from './skill-run.service';

export const SKILL_BRIEF_PROMPT = { family: 'skill_brief', version: 'v0002' };

/** Caps that bound one brief synthesis call (the research-synthesis shape). */
const MAX_BRIEF_PAGES = 12;
const PAGE_EXCERPT_CHARS = 4000;
const MAX_BRIEF_FACTS = 14;
const MAX_BRIEF_LOOPS = 6;

/**
 * The skill engine: everything after the plan gate. The app
 * calls {@link approvePlan} (the ONE-interaction gate) and {@link cancel};
 * the worker's re-runnable `skill.advance` job calls {@link advance}, which
 * claims the next step, executes it, checkpoints, and continues — resumable
 * from the rows alone, budget-capped with graceful partial completion.
 *
 * Governance lives elsewhere and is only USED here: discovery and capture go
 * through ResearchService (the 0045 gate, budgets, SSRF guard); a skill
 * reads, searches and writes a brief, and creates nothing else.
 */
@Injectable()
export class SkillEngine {
  private prompt?: PromptArtifact;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly runs: SkillRunService,
    private readonly research: ResearchService,
    private readonly gateway: ModelGateway,
    private readonly memories: MemoryStore,
    @Inject(RESEARCH_QUOTA) private readonly quota: ResearchQuota,
    @Optional() private readonly userContext?: UserContextService,
    @Optional()
    @Inject(INSTANCE_TIMEZONE)
    private readonly instanceTimeZone: string = DEFAULT_INSTANCE_TIMEZONE,
  ) {}

  /**
   * The plan gate, one interaction: every kept query
   * (possibly edited) flips its research run to approved with the text as
   * sent_query; every omitted query is cancelled and never leaves. The run
   * moves to `running` and the advance job is enqueued transactionally with
   * that flip.
   */
  async approvePlan(
    principal: Principal,
    runId: string,
    decisions: { researchRunId: string; query: string }[],
  ): Promise<SkillRunRow> {
    const run = await this.runs.getRun(principal, runId);
    if (!run) throw new NotFoundException();
    if (run.status === 'running') return run; // an approve retry after a crash
    if (run.status !== 'awaiting_approval') {
      throw new ConflictException('this skill run is not awaiting plan approval');
    }
    if (decisions.length === 0) {
      throw new ConflictException('approve at least one query, or cancel the run');
    }
    if (decisions.length > this.quota.skillQueriesMax) {
      throw new ConflictException(
        `a skill plan approves at most ${this.quota.skillQueriesMax} queries`,
      );
    }
    const planRuns = await this.research.runsForSkill(runId);
    const byId = new Map(planRuns.map((r) => [r.id, r]));
    for (const decision of decisions) {
      if (!byId.has(decision.researchRunId)) {
        throw new NotFoundException('a decision references a query outside this plan');
      }
    }
    const keptIds = new Set(decisions.map((d) => d.researchRunId));
    let edited = 0;
    for (const decision of decisions) {
      const planRun = byId.get(decision.researchRunId)!;
      if (decision.query.trim() !== planRun.minimisedQuery) edited += 1;
      await this.research.approveQuery(principal, decision.researchRunId, decision.query);
    }
    for (const planRun of planRuns) {
      if (!keptIds.has(planRun.id) && planRun.status === 'proposed') {
        await this.research.cancel(principal, planRun.id);
      }
    }
    // The status flip, its audit row, and the advance enqueue commit together.
    const updated = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(skillRun)
        .set({ status: 'running' })
        .where(and(eq(skillRun.id, runId), inArray(skillRun.status, ['awaiting_approval'])))
        .returning();
      const row = rows[0];
      if (!row) return null;
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'skill_run.plan_approved',
        entityType: 'skill_run',
        entityId: runId,
        detail: {
          kept: decisions.length,
          removed: planRuns.filter((r) => !keptIds.has(r.id)).length,
          edited,
        },
        orgId: principal.orgId,
        ownerId: principal.userId,
      });
      await withTransactionalEnqueue(
        tx,
        {
          type: 'skill_run.plan_approved',
          payload: { source_type: 'skill_run', source_id: runId, owner_id: principal.userId },
        },
        {
          type: SKILL_ADVANCE_JOB_TYPE,
          payload: { source_type: 'skill_run', source_id: runId },
          principalId: principal.userId, // SEC-10
        },
      );
      return row;
    });
    return updated ?? (await this.runs.getRun(principal, runId))!;
  }

  /**
   * The worker's advance pass: execute every step that can run NOW, stop at
   * the first that must wait (extraction settling), and complete the run when
   * nothing is left. Re-delivery is safe — steps re-claim and every effect is
   * guarded (searched queries recorded, capture guarded by existing pages,
   * terminal transitions compare-and-set).
   */
  async advance(runId: string): Promise<{ advanced: boolean }> {
    const run = await this.runs.getRunById(runId);
    if (!run || run.status !== 'running') return { advanced: false };
    const owner = ownerPrincipal(run);
    const steps = await this.runs.steps(runId);
    const pending = (key: string) =>
      steps.some((s) => s.stepKey === key && s.status !== 'completed' && s.status !== 'skipped');

    // A cancel lands between steps: each boundary re-checks the run status so
    // cancellation stops cleanly and keeps what was produced (ruling 5).
    const stillRunning = async () => (await this.runs.getRunById(runId))?.status === 'running';

    try {
      if (pending('gated_search')) {
        await this.executeGatedSearch(owner, run);
      }
      if (pending('read_pages')) {
        if (!(await stillRunning())) return { advanced: false };
        const settled = await this.checkPagesSettled(owner, run);
        if (!settled) return { advanced: true }; // the settle-watcher re-enqueues
      }
      if (pending('verify')) {
        if (!(await stillRunning())) return { advanced: false };
        await this.executeVerify(owner, run);
      }
      if (pending('write_brief')) {
        if (!(await stillRunning())) return { advanced: false };
        await this.executeBrief(owner, run);
      }
    } catch (error) {
      // A cancelled run stops cleanly between steps; anything else marks the
      // step failed (honest in the run view) and rethrows so the queue retries
      // with backoff and dead-letters visibly.
      const current = await this.runs.getRunById(runId);
      if (current?.status !== 'running') return { advanced: false };
      const failing = (await this.runs.steps(runId)).find((s) => s.status === 'running');
      if (failing) {
        await this.runs.failStep(
          runId,
          failing.stepKey,
          error instanceof Error ? error.message : 'step failed',
        );
      }
      throw error;
    }

    const completed = await this.runs.transition(runId, 'running', 'completed');
    if (completed) {
      await this.runs.auditRun('worker:skill_engine', 'skill_run.completed', completed);
    }
    return { advanced: true };
  }

  /**
   * Discovery + capture for every approved query, through ResearchService
   * verbatim (budgets, robots, SSRF guard, focused extraction). Budget
   * exhaustion is graceful: the remaining queries are noted as skipped and the
   * run continues with what was gathered.
   */
  private async executeGatedSearch(owner: Principal, run: SkillRunRow): Promise<void> {
    await this.runs.claimStep(run.id, 'gated_search');
    const planRuns = (await this.research.runsForSkill(run.id)).filter(
      (r) => r.status === 'approved',
    );
    const step = (await this.runs.steps(run.id)).find((s) => s.stepKey === 'gated_search');
    const links = (step?.links ?? {}) as SkillStepLinks;
    const searched = new Set(links.searched ?? []);
    const pageIds: string[] = [...(links.pageIds ?? [])];
    const notes: string[] = [...(links.notes ?? [])];
    let budgetStopped = false;

    for (const planRun of planRuns) {
      if (searched.has(planRun.id)) continue;
      // Resume guard: a crash after capture but before the checkpoint —
      // existing pages mean this query already ran.
      const existing = await this.research.pagesForRun(owner, planRun.id);
      if (existing.length > 0) {
        searched.add(planRun.id);
        for (const page of existing) if (!pageIds.includes(page.id)) pageIds.push(page.id);
        await this.checkpointSearch(run.id, searched, pageIds, notes);
        continue;
      }
      if (budgetStopped) continue;
      let outcome;
      try {
        outcome = (await this.research.searchApproved(owner, planRun.id)).search;
      } catch (error) {
        if (isDailyBudget(error)) {
          budgetStopped = true;
          notes.push('daily research budget reached, continuing with what was gathered');
          await this.checkpointSearch(run.id, searched, pageIds, notes);
          continue;
        }
        throw error;
      }
      if (outcome.status !== 'ok') {
        notes.push(`search unavailable for one query (${outcome.reason})`);
        searched.add(planRun.id);
        await this.checkpointSearch(run.id, searched, pageIds, notes);
        continue;
      }
      const urls = selectPagesForSubject(
        outcome.results,
        run.subject,
        this.quota.skillPagesPerQuery,
      );
      if (urls.length > 0) {
        const captured = await this.research.capture(owner, urls, 'private', planRun.id);
        for (const result of captured) {
          if (result.status === 'captured') pageIds.push(result.id);
          else if (result.reason === 'limit_reached') {
            budgetStopped = true;
            notes.push('daily page budget reached, continuing with what was gathered');
          }
        }
      } else {
        notes.push('one query returned no usable results');
      }
      searched.add(planRun.id);
      await this.checkpointSearch(run.id, searched, pageIds, notes);
    }

    const skipped = planRuns.length - searched.size;
    await this.runs.finishStep(run.id, 'gated_search', {
      status: 'completed',
      outputsSummary:
        `${searched.size} of ${planRuns.length} approved ${planRuns.length === 1 ? 'search' : 'searches'} sent, ` +
        `${pageIds.length} ${pageIds.length === 1 ? 'page' : 'pages'} selected` +
        (skipped > 0 ? ` (${skipped} skipped at the budget)` : ''),
      links: {
        searched: [...searched],
        pageIds,
        notes,
        counts: { searches: searched.size, pages: pageIds.length },
      },
    });
    await this.runs.patchStep(run.id, 'gated_search', {
      inputsSummary: `${planRuns.length} approved ${planRuns.length === 1 ? 'query' : 'queries'}`,
    });
  }

  private async checkpointSearch(
    runId: string,
    searched: Set<string>,
    pageIds: string[],
    notes: string[],
  ): Promise<void> {
    await this.runs.patchStep(runId, 'gated_search', {
      links: { searched: [...searched], pageIds, notes },
    });
  }

  /**
   * The reading wait: complete when every captured page settled (done or
   * dead-lettered); otherwise record honest progress and let the
   * settle-watcher re-enqueue the advance. Zero captured pages settle
   * trivially — the brief is then written from memory alone.
   */
  private async checkPagesSettled(owner: Principal, run: SkillRunRow): Promise<boolean> {
    await this.runs.claimStep(run.id, 'read_pages');
    const pages = await this.pagesForSkillRun(owner, run.id);
    let done = 0;
    let failed = 0;
    for (const page of pages) {
      const state = await this.research.getProcessingState(page.id);
      if (state === 'done') done += 1;
      else if (state === 'failed') failed += 1;
    }
    const settled = done + failed;
    if (settled < pages.length) {
      await this.runs.patchStep(run.id, 'read_pages', {
        inputsSummary: `${pages.length} captured ${pages.length === 1 ? 'page' : 'pages'}`,
        outputsSummary: `Read ${settled} of ${pages.length} pages…`,
        links: { pageIds: pages.map((p) => p.id) },
      });
      return false;
    }
    let facts = 0;
    for (const page of pages) {
      facts += (await this.memories.listBySourceSystem('web', page.id)).length;
    }
    await this.runs.finishStep(run.id, 'read_pages', {
      status: pages.length === 0 ? 'skipped' : 'completed',
      outputsSummary:
        pages.length === 0
          ? 'No pages to read: the brief draws on memory alone'
          : `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} read, ${facts} ${facts === 1 ? 'fact' : 'facts'} extracted` +
            (failed > 0 ? ` (${failed} failed permanently)` : ''),
      links: { pageIds: pages.map((p) => p.id), counts: { pages: pages.length, facts, failed } },
    });
    return true;
  }

  /**
   * Verification already ran per fact inside the pipeline (spec §2); this step
   * reads the outcome so the log — and the brief — can say it: how many facts
   * verified, and which stand contradicted or uncertain after reconciliation.
   */
  private async executeVerify(owner: Principal, run: SkillRunRow): Promise<void> {
    await this.runs.claimStep(run.id, 'verify');
    const pages = await this.pagesForSkillRun(owner, run.id);
    const webMemories: MemoryRow[] = [];
    for (const page of pages) {
      webMemories.push(...(await this.memories.listBySourceSystem('web', page.id)));
    }
    // The gathered profile re-read: reconciliation may have flagged a stored
    // memory against a fresh web fact while the pages settled.
    const gatherLinks = await this.stepLinks(run.id, 'gather_memory');
    const profileRows = await this.memories.getManySystem(gatherLinks.memoryIds ?? []);
    const disputed = [...webMemories, ...profileRows].filter(
      (row) => row.status === 'contradicted' || row.status === 'uncertain',
    );
    const contradicted = disputed.filter((row) => row.status === 'contradicted');
    await this.runs.finishStep(run.id, 'verify', {
      status: 'completed',
      outputsSummary:
        webMemories.length === 0 && disputed.length === 0
          ? 'Nothing new to verify'
          : `${webMemories.length} web ${webMemories.length === 1 ? 'fact' : 'facts'} verified; ` +
            `${contradicted.length} contradicted, ${disputed.length - contradicted.length} uncertain`,
      links: {
        memoryIds: disputed.map((r) => r.id),
        counts: {
          webFacts: webMemories.length,
          contradicted: contradicted.length,
          uncertain: disputed.length - contradicted.length,
        },
      },
    });
  }

  /** The one answer-tier call: the brief, cited per claim, anchor language. */
  private async executeBrief(owner: Principal, run: SkillRunRow): Promise<void> {
    await this.runs.claimStep(run.id, 'write_brief');
    const gatherLinks = await this.stepLinks(run.id, 'gather_memory');
    const verifyLinks = await this.stepLinks(run.id, 'verify');
    const profileIds = gatherLinks.memoryIds ?? [];
    const loopIds = gatherLinks.loopMemoryIds ?? [];
    const factRows = (await this.memories.getManySystem(profileIds)).slice(0, MAX_BRIEF_FACTS);
    const loopRows = (await this.memories.getManySystem(loopIds)).slice(0, MAX_BRIEF_LOOPS);
    const disputedRows = await this.memories.getManySystem(verifyLinks.memoryIds ?? []);
    const pages = (await this.pagesForSkillRun(owner, run.id)).slice(0, MAX_BRIEF_PAGES);

    // [M#] numbers the remembered facts then the open loops; [W#] the pages.
    const memoryRows = [
      ...factRows,
      ...loopRows.filter((l) => !factRows.some((f) => f.id === l.id)),
    ];
    const boundary = untrustedBoundary();
    const factBlocks = memoryRows.map(
      (m, i) =>
        `[M${i + 1}] (status: ${m.status})\n` + fenceUntrusted(m.content ?? '(withheld)', boundary),
    );
    const loopBlocks = loopRows.map((l) => {
      const at = memoryRows.findIndex((m) => m.id === l.id);
      return `[M${at + 1}] ${l.content ?? '(withheld)'}`;
    });
    // SEC-4: same treatment as research synthesis. The brief is Cogeto-initiated
    // and its sources are fetched pages, so everything they contributed is
    // fenced; markers, url and fetch date stay outside for citation resolution.
    const webBlocks = pages.map((page, i) => {
      const fetched = page.fetchedAt.toISOString().slice(0, 10);
      return (
        `[W${i + 1}] url: ${page.finalUrl}\nfetched: ${fetched}\n` +
        `title and text:\n` +
        fenceUntrusted(
          `${page.title ?? '(untitled page)'}\n` +
            `${(page.extractionText ?? page.retainedText).slice(0, PAGE_EXCERPT_CHARS)}`,
          boundary,
        )
      );
    });
    const contradictionBlocks = disputedRows.map((row) => {
      const at = memoryRows.findIndex((m) => m.id === row.id);
      const marker = at >= 0 ? `[M${at + 1}] ` : '';
      return `- ${marker}${row.content ?? '(withheld)'} (status: ${row.status})`;
    });

    // The brief is Cogeto-initiated: the LANGUAGE line is
    // forced to the strict/anchor form so it always speaks preferred_language.
    const contextRecord = await Promise.resolve(this.userContext?.get(run.ownerId))
      .then((record) => record ?? EMPTY_USER_CONTEXT)
      .catch(() => EMPTY_USER_CONTEXT);
    const contextBlock = buildContextBlock(
      { ...contextRecord, languageStrict: true },
      new Date(),
      contextRecord.timezone ?? this.instanceTimeZone,
      { language: true },
    );

    this.prompt ??= await loadPrompt(SKILL_BRIEF_PROMPT.family, SKILL_BRIEF_PROMPT.version);
    const raw = await this.gateway.complete({
      system: this.prompt.content,
      input:
        `${contextBlock}\n\n` +
        `SUBJECT:\n${run.subject}\n\n` +
        `WHAT MEMORY KNOWS:\n${factBlocks.join('\n') || '(nothing on record)'}\n\n` +
        `OPEN LOOPS:\n${loopBlocks.join('\n') || '(none)'}\n\n` +
        `WEB SOURCES:\n${webBlocks.join('\n\n') || '(none)'}` +
        (contradictionBlocks.length > 0
          ? `\n\nCONTRADICTIONS:\n${contradictionBlocks.join('\n')}`
          : ''),
      tier: 'answer',
    });

    const { answer, citations } = resolveBriefMarkers(raw.text, pages, memoryRows);
    const memoryCites = citations.filter((c) => c.kind === 'memory').length;
    const webCites = citations.length - memoryCites;
    await this.runs.transition(run.id, 'running', 'running', {
      brief: answer,
      briefCitations: citations,
    });
    await this.runs.finishStep(run.id, 'write_brief', {
      status: 'completed',
      outputsSummary: `Brief written, ${memoryCites} memory ${memoryCites === 1 ? 'citation' : 'citations'}, ${webCites} web`,
      links: { counts: { memoryCitations: memoryCites, webCitations: webCites } },
    });
  }

  private async pagesForSkillRun(owner: Principal, runId: string): Promise<WebPageRow[]> {
    const planRuns = await this.research.runsForSkill(runId);
    const pages: WebPageRow[] = [];
    for (const planRun of planRuns) {
      pages.push(...(await this.research.pagesForRun(owner, planRun.id)));
    }
    return pages;
  }

  private async stepLinks(runId: string, stepKey: string): Promise<SkillStepLinks> {
    const step = (await this.runs.steps(runId)).find((s) => s.stepKey === stepKey);
    return (step?.links ?? {}) as SkillStepLinks;
  }
}

/** The worker acts as the run's owner (the research-conclusion precedent) —
 * with the REAL org captured at propose time, so object keys hold. */
function ownerPrincipal(run: SkillRunRow): Principal {
  return { userId: run.ownerId, name: '', email: null, orgId: run.orgId, orgName: '', roles: [] };
}

function isDailyBudget(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const response = error.getResponse();
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as { code?: unknown }).code === 'daily_research_limit'
  );
}

/**
 * Keep only markers that resolve to a supplied source; strip the rest (the
 * research-synthesis sanitize rule — an invented citation never survives).
 */
export function resolveBriefMarkers(
  text: string,
  pages: WebPageRow[],
  memoryRows: Pick<MemoryRow, 'id'>[],
): { answer: string; citations: ResearchCitationDto[] } {
  const seen = new Map<string, ResearchCitationDto>();
  const answer = text
    .replace(/\[([WM])(\d+)\]/g, (whole, kind: string, num: string) => {
      const index = Number(num) - 1;
      if (kind === 'W') {
        const page = pages[index];
        if (!page) return '';
        seen.set(whole, {
          kind: 'web',
          marker: whole,
          url: page.finalUrl,
          title: page.title,
          fetchedAt: page.fetchedAt.toISOString(),
          webPageId: page.id,
        });
        return whole;
      }
      const memory = memoryRows[index];
      if (!memory) return '';
      seen.set(whole, { kind: 'memory', marker: whole, memoryId: memory.id });
      return whole;
    })
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { answer, citations: [...seen.values()] };
}
