import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { resolveSpaceId } from '@cogeto/shared';
import type { MemoryScope, Principal, WebProcessingState } from '@cogeto/shared';
import {
  DailyCounters,
  DRIZZLE,
  jobRunState,
  RESEARCH_QUOTA,
  userError,
  withTransactionalEnqueue,
  writeAudit,
} from '../infrastructure/index';
import type { Db, ResearchQuota } from '../infrastructure/index';
import { chunkContent, INGESTION_PIPELINE_JOB_TYPE } from '../ingestion/index';
import { MemoryObjectStore, MemoryStore } from '../memory/index';
import { ModelGateway } from '../model-gateway/index';
import { sanitizeHtml } from '../email/index';
import { minimiseQuery } from './research-minimise';
import { researchRun, webPage } from './persistence/tables';
import type { ResearchRunRow, WebPageRow } from './persistence/tables';
import { RESEARCH_OPTIONS } from './research-options';
import type { ResearchOptions } from './research-options';
import { WebDiscoveryService } from './web-discovery.service';
import type { DiscoveryOutcome } from './web-discovery.service';
import { WebFetchService } from './web-fetch';

/**
 * Web research: explicitly invoked,
 * never ambient. `search` runs one discovery query; `capture` fetches the URLs
 * the user selected and turns each page into a first-class web source — the
 * row, its domain event and its pipeline job commit together (spec §15.4), exactly
 * like a note or an email. Derived memories carry provenance
 * source_type = 'web' → web_page.id, and their temporal anchor is the fetch
 * time, so "as of when?" is always answerable.
 *
 * Budgets (the existing infrastructure): searches and fetched pages are
 * each capped per user per day, and one capture request is capped at
 * `pagesPerRunMax` pages — bounding both spend and blast radius before any
 * model work happens.
 */

/** One capture request's per-URL outcome — honest about every skip. */
export type CaptureResult =
  | { url: string; status: 'captured'; id: string; title: string | null }
  | { url: string; status: 'skipped'; reason: string; detail: string };

const CLEANUP_ATTEMPTS = 3;

/** The focused-extraction thresholds: pages splitting into
 * fewer chunks than FOCUS_MIN_CHUNKS are cheap enough to extract whole; bigger
 * ones keep only the FOCUS_TOP_CHUNKS most query-relevant chunks (embeddings
 * only — no model calls) for the extractor, in document order. */
const FOCUS_MIN_CHUNKS = 7;
const FOCUS_TOP_CHUNKS = 6;

@Injectable()
export class ResearchService {
  private readonly log = new Logger(ResearchService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly discovery: WebDiscoveryService,
    private readonly fetcher: WebFetchService,
    private readonly objects: MemoryObjectStore,
    private readonly counters: DailyCounters,
    @Inject(RESEARCH_QUOTA) private readonly quota: ResearchQuota,
    @Inject(RESEARCH_OPTIONS) private readonly options: ResearchOptions,
    private readonly gateway: ModelGateway,
    // The memory module's public interface (FilesService precedent): the
    // progress feed counts a page's derived facts without touching tables.
    // Optional so narrow test harnesses without a vector store still build;
    // the app root always resolves it (MemoryModule is global).
    @Optional() private readonly memories?: MemoryStore,
  ) {}

  /**
   * Open the gate (Part B): minimise the query and record
   * a PROPOSED run. Sends NOTHING — discovery runs only from `approve`. The
   * proposed query is the intent verbatim (chat strips its trigger verb first);
   * minimisation rewrites it to the least-identifying serving form.
   */
  async propose(
    principal: Principal,
    intent: string,
    conversationId: string | null = null,
  ): Promise<ResearchRunRow> {
    const proposedQuery = intent.trim();
    const minimised = await minimiseQuery(this.gateway, intent, proposedQuery);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(researchRun)
        .values({
          ownerId: principal.userId,
          // The caller's current space (docs/features/spaces.md); every page
          // this run captures inherits it.
          spaceId: resolveSpaceId(principal),
          intent,
          proposedQuery,
          minimisedQuery: minimised.minimised,
          minimiseReason: minimised.reason,
          // The invoking conversation: where the concluded
          // answer is appended. NULL for Research-page runs.
          conversationId,
        })
        .returning();
      // Structural audit only: the transition, never the query text —
      // the text lives on the owner-gated run row itself.
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'research_run.proposed',
        entityType: 'research_run',
        entityId: row!.id,
        orgId: principal.orgId,
        ownerId: principal.userId,
        spaceId: row!.spaceId,
      });
      return row!;
    });
  }

  /**
   * A skill plan's query: an ordinary proposed run,
   * tagged with its skill run. Minimisation happened at generation (the
   * skill_plan prompt), so the pre-minimised text and its reason are recorded
   * verbatim — the gate shows them exactly as manual research shows the
   * minimise pass's output. Sends NOTHING.
   */
  async proposeForSkill(
    principal: Principal,
    skillRunId: string,
    proposal: { intent: string; query: string; reason: string },
  ): Promise<ResearchRunRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(researchRun)
        .values({
          ownerId: principal.userId,
          spaceId: resolveSpaceId(principal),
          intent: proposal.intent,
          proposedQuery: proposal.query,
          minimisedQuery: proposal.query,
          minimiseReason: proposal.reason,
          skillRunId,
        })
        .returning();
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'research_run.proposed',
        entityType: 'research_run',
        entityId: row!.id,
        detail: { skill_run_id: skillRunId },
        orgId: principal.orgId,
        ownerId: principal.userId,
        spaceId: row!.spaceId,
      });
      return row!;
    });
  }

  /** A skill run's plan queries, oldest first (the gate's list). */
  async runsForSkill(skillRunId: string): Promise<ResearchRunRow[]> {
    return this.db
      .select()
      .from(researchRun)
      .where(eq(researchRun.skillRunId, skillRunId))
      .orderBy(researchRun.createdAt);
  }

  /**
   * The ONLY path to discovery: explicit approval records the
   * exact (possibly user-edited) query text on the run, then sends it. An
   * already-approved run may re-run discovery with the SAME recorded query
   * (an engine hiccup is retryable); a different text needs a new run — the
   * record of what left is immutable.
   */
  async approveAndSearch(
    principal: Principal,
    runId: string,
    query: string,
  ): Promise<{ run: ResearchRunRow; search: DiscoveryOutcome }> {
    const run = await this.approveQuery(principal, runId, query);
    const search = await this.search(principal, run.sentQuery!);
    return { run, search };
  }

  /**
   * Approval without discovery: the skill plan gate flips each
   * kept run to approved with its (possibly edited) text in ONE interaction;
   * the worker's advance job runs discovery afterwards via
   * {@link searchApproved}. The 0045 invariant is untouched — discovery still
   * happens only against an approved run's immutable sent_query.
   */
  async approveQuery(principal: Principal, runId: string, query: string): Promise<ResearchRunRow> {
    const sentQuery = query.trim();
    if (!sentQuery)
      throw userError.conflict('research.blankQuery', 'the approved query must not be blank');
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(researchRun)
        .where(
          and(
            eq(researchRun.id, runId),
            eq(researchRun.ownerId, principal.userId),
            // Approving is space-sealed like reading (docs/features/spaces.md):
            // a run in another space is not found, even for its owner.
            eq(researchRun.spaceId, resolveSpaceId(principal)),
          ),
        )
        .for('update');
      const row = rows[0];
      if (!row) throw userError.notFound('research.runNotFound', 'no such research run');
      if (row.status === 'cancelled') {
        throw userError.conflict(
          'research.cancelled',
          'this research was cancelled, propose it again',
        );
      }
      if (row.status === 'approved') {
        if (row.sentQuery !== sentQuery) {
          throw userError.conflict(
            'research.alreadyRanDifferentQuery',
            'this research already ran with a different approved query, propose a new one',
          );
        }
        return row; // retry with the SAME recorded query — no state change
      }
      const [updated] = await tx
        .update(researchRun)
        .set({ status: 'approved', sentQuery, approvedAt: new Date() })
        .where(eq(researchRun.id, runId))
        .returning();
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'research_run.approved',
        entityType: 'research_run',
        entityId: runId,
        detail: { edited: sentQuery !== row.minimisedQuery },
        orgId: principal.orgId,
        ownerId: principal.userId,
        spaceId: row.spaceId,
      });
      return updated!;
    });
  }

  /**
   * Discovery for an ALREADY-approved run: the skill advance
   * job's search step. Uses the immutable recorded sent_query; budget-gated
   * exactly like the interactive path.
   */
  async searchApproved(
    principal: Principal,
    runId: string,
  ): Promise<{ run: ResearchRunRow; search: DiscoveryOutcome }> {
    const run = await this.getRun(principal, runId);
    if (!run) throw userError.notFound('research.runNotFound', 'no such research run');
    if (run.status !== 'approved' || !run.sentQuery) {
      throw userError.conflict(
        'research.discoveryNeedsApproval',
        'discovery requires an approved research run',
      );
    }
    const search = await this.search(principal, run.sentQuery);
    return { run, search };
  }

  /** Cancel at the gate: nothing was sent, nothing will be. Idempotent. */
  async cancel(principal: Principal, runId: string): Promise<ResearchRunRow> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(researchRun)
        .where(
          and(
            eq(researchRun.id, runId),
            eq(researchRun.ownerId, principal.userId),
            // Cancelling is space-sealed like approving, and for the same
            // reason (docs/features/spaces.md).
            eq(researchRun.spaceId, resolveSpaceId(principal)),
          ),
        )
        .for('update');
      const row = rows[0];
      if (!row) throw userError.notFound('research.runNotFound', 'no such research run');
      if (row.status === 'cancelled') return row;
      if (row.status === 'approved') {
        throw userError.conflict(
          'research.alreadyRan',
          'this research already ran: its query has left',
        );
      }
      const [updated] = await tx
        .update(researchRun)
        .set({ status: 'cancelled', cancelledAt: new Date() })
        .where(eq(researchRun.id, runId))
        .returning();
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'research_run.cancelled',
        entityType: 'research_run',
        entityId: runId,
        orgId: principal.orgId,
        ownerId: principal.userId,
        spaceId: row.spaceId,
      });
      return updated!;
    });
  }

  async getRun(principal: Principal, runId: string): Promise<ResearchRunRow | null> {
    const rows = await this.db
      .select()
      .from(researchRun)
      .where(
        and(
          eq(researchRun.id, runId),
          eq(researchRun.ownerId, principal.userId),
          // Space-scoped like every read (docs/features/spaces.md): a run in
          // another space is not found, even for its owner.
          eq(researchRun.spaceId, resolveSpaceId(principal)),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** System read for the worker's conclusion job — no
   * principal exists there; the row's own ownerId scopes everything after. */
  async getRunById(runId: string): Promise<ResearchRunRow | null> {
    const rows = await this.db.select().from(researchRun).where(eq(researchRun.id, runId)).limit(1);
    return rows[0] ?? null;
  }

  async listRuns(principal: Principal, limit = 50): Promise<ResearchRunRow[]> {
    return this.db
      .select()
      .from(researchRun)
      .where(
        and(
          eq(researchRun.ownerId, principal.userId),
          // The Research page lists the caller's current space only
          // (docs/features/spaces.md).
          eq(researchRun.spaceId, resolveSpaceId(principal)),
        ),
      )
      .orderBy(desc(researchRun.createdAt))
      .limit(limit);
  }

  /** Pages captured under a run — synthesis input, oldest first. */
  async pagesForRun(principal: Principal, runId: string): Promise<WebPageRow[]> {
    return this.db
      .select()
      .from(webPage)
      .where(and(eq(webPage.researchRunId, runId), eq(webPage.ownerId, principal.userId)))
      .orderBy(webPage.createdAt);
  }

  /**
   * The in-chat flow's honest wait: each captured page's
   * pipeline state (queue-ledger derivation, the notes rule) plus how many
   * facts it has yielded so far. Owner-gated via getRun; a run with no
   * captured pages simply reports an empty list.
   */
  async runProgress(
    principal: Principal,
    runId: string,
  ): Promise<
    {
      id: string;
      url: string;
      title: string | null;
      state: WebProcessingState;
      factCount: number;
    }[]
  > {
    const run = await this.getRun(principal, runId);
    if (!run) throw userError.notFound('research.runNotFound', 'no such research run');
    const pages = await this.pagesForRun(principal, runId);
    return Promise.all(
      pages.map(async (page) => ({
        id: page.id,
        url: page.finalUrl,
        title: page.title,
        state: await this.getProcessingState(page.id),
        // Gated (V2.0 item 3.7): this is a request path, so the count goes
        // through the owner gate like every other read. The page belongs to the
        // caller (getRun + pagesForRun above), and a page's derived memories
        // carry the page's owner, so the number is the one this always showed.
        factCount: this.memories
          ? await this.memories.countBySourceForPrincipal(principal, 'web', page.id)
          : 0,
      })),
    );
  }

  /** The approved query behind a captured page (provenance, Part B). */
  async sentQueryFor(row: WebPageRow): Promise<string | null> {
    if (!row.researchRunId) return null;
    const rows = await this.db
      .select({ sentQuery: researchRun.sentQuery })
      .from(researchRun)
      .where(eq(researchRun.id, row.researchRunId))
      .limit(1);
    return rows[0]?.sentQuery ?? null;
  }

  /** One discovery query, budget-gated. Reserved BEFORE the search runs. */
  async search(principal: Principal, query: string): Promise<DiscoveryOutcome> {
    if ((await this.counters.get(principal.userId, 'research_search')) >= this.quota.searchesMax) {
      throw userError.tooManyRequests(
        'daily_research_limit',
        'daily research search limit reached ({{max}}), try again tomorrow',
        { max: this.quota.searchesMax },
      );
    }
    await this.counters.add(principal.userId, 'research_search', 1);
    return this.discovery.search(query);
  }

  /**
   * Fetch the selected URLs and store each fetched page as a web source.
   * Every URL gets an outcome; the daily page budget is checked per page and
   * exhaustion annotates the remainder instead of failing the request.
   */
  async capture(
    principal: Principal,
    urls: string[],
    scope: MemoryScope = 'private',
    researchRunId: string | null = null,
  ): Promise<CaptureResult[]> {
    let run: ResearchRunRow | null = null;
    if (researchRunId) {
      run = await this.getRun(principal, researchRunId);
      if (!run) throw userError.notFound('research.runNotFound', 'no such research run');
      if (run.status !== 'approved') {
        throw userError.conflict(
          'research.captureNeedsApproval',
          'capture requires an approved research run',
        );
      }
    }
    if (urls.length > this.quota.pagesPerRunMax) {
      throw userError.badRequest(
        'research_page_cap',
        'a single research fetches at most {{max}} pages',
        { max: this.quota.pagesPerRunMax },
      );
    }
    const results: CaptureResult[] = [];
    for (const url of urls) {
      if ((await this.counters.get(principal.userId, 'research_page')) >= this.quota.pagesMax) {
        results.push({
          url,
          status: 'skipped',
          reason: 'limit_reached',
          detail: `daily research page limit reached (${this.quota.pagesMax}), try again tomorrow`,
        });
        continue;
      }
      // Reserved BEFORE the fetch (the notes-quota rule): a failed fetch still
      // consumed outbound work, so it still counts.
      await this.counters.add(principal.userId, 'research_page', 1);
      const outcome = await this.fetcher.fetchPage(url);
      if (outcome.status === 'skipped') {
        results.push({ url, status: 'skipped', reason: outcome.reason, detail: outcome.detail });
        continue;
      }
      const { page } = outcome;
      const id = randomUUID();

      // Optional raw-HTML retention: sanitised (the email-intake rule, now a
      // parser-based allowlist rather than regexes — audit 2.0 SEC-7) and
      // object-first, so the tx below can reference the key knowing the bytes
      // exist. The allowlist keeps the body's markup and drops the document
      // wrapper along with everything executable; this artifact is a display
      // copy, and `retained_text` is the complete, unaltered record.
      let rawObjectKey: string | null = null;
      if (this.options.retainHtml && page.rawHtml) {
        const sanitised = sanitizeHtml(page.rawHtml);
        if (sanitised) {
          rawObjectKey = `${principal.orgId}/${principal.userId}/${scope}/web-${id}.html`;
          await this.objects.putObject(rawObjectKey, Buffer.from(sanitised, 'utf8'), {
            contentType: 'text/html',
            metadata: { 'owner-id': principal.userId, scope, sensitive: 'false' },
          });
        }
      }

      // The focused extraction view: rank the page's chunks
      // against the run's approved query by embeddings alone and keep the most
      // relevant ones for the extractor. retained_text stays complete.
      const extractionText = run?.sentQuery
        ? await this.focusExtractionText(run.sentQuery, page.text)
        : null;

      try {
        await this.db.transaction(async (tx) => {
          await tx.insert(webPage).values({
            id,
            ownerId: principal.userId,
            scope,
            // The RUN's space when the capture belongs to a run, else the
            // caller's current space (docs/features/spaces.md): stamped in
            // the same transaction that creates the source.
            spaceId: run?.spaceId ?? resolveSpaceId(principal),
            requestedUrl: page.requestedUrl,
            finalUrl: page.finalUrl,
            title: page.title,
            fetchedAt: page.fetchedAt,
            retainedText: page.text,
            extractionText,
            rawObjectKey,
            researchRunId,
          });
          await withTransactionalEnqueue(
            tx,
            {
              type: 'web.page.captured',
              payload: { source_type: 'web', source_id: id, owner_id: principal.userId },
            },
            {
              type: INGESTION_PIPELINE_JOB_TYPE,
              payload: { source_type: 'web', source_id: id },
            },
          );
        });
      } catch (error) {
        if (rawObjectKey) await this.cleanupOrphanObject(rawObjectKey);
        throw error;
      }
      results.push({ url, status: 'captured', id, title: page.title });
    }
    return results;
  }

  /** Owner-only read — the source drawer behind every web memory. */
  async getForOwner(principal: Principal, id: string): Promise<WebPageRow | null> {
    const rows = await this.db
      .select()
      .from(webPage)
      .where(
        and(
          eq(webPage.id, id),
          eq(webPage.ownerId, principal.userId),
          // The retained page body is content: sealed with its space like
          // every other by-id read (docs/features/spaces.md).
          eq(webPage.spaceId, resolveSpaceId(principal)),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Processing state from the queue's own ledgers — the notes-source rule. */
  async getProcessingState(id: string): Promise<WebProcessingState> {
    return jobRunState(this.db, {
      sourceType: 'web',
      sourceId: id,
      jobType: INGESTION_PIPELINE_JOB_TYPE,
    });
  }

  /**
   * Persist the synthesised answer and conclude the run —
   * the terminal success state. GUARDED on 'approved' so a racing worker and
   * interactive conclusion cannot both win: the loser returns
   * false and must not append or re-deliver anything. `seen` marks the answer
   * acknowledged in the same write (watched interactively, or delivered into
   * its conversation).
   */
  async recordConclusion(runId: string, answer: string, opts: { seen: boolean }): Promise<boolean> {
    const now = new Date();
    const updated = await this.db
      .update(researchRun)
      .set({
        answer,
        status: 'concluded',
        concludedAt: now,
        ...(opts.seen ? { answerSeenAt: now } : {}),
      })
      .where(and(eq(researchRun.id, runId), eq(researchRun.status, 'approved')))
      .returning({ id: researchRun.id });
    return updated.length > 0;
  }

  /** The owner saw the stored answer — the chat resume surface stops showing
   * this run. Idempotent. */
  async markAnswerSeen(principal: Principal, runId: string): Promise<void> {
    const run = await this.getRun(principal, runId);
    if (!run) throw userError.notFound('research.runNotFound', 'no such research run');
    if (run.answerSeenAt) return;
    await this.db
      .update(researchRun)
      .set({ answerSeenAt: new Date() })
      .where(eq(researchRun.id, runId));
  }

  /**
   * The relevance pre-pass: split the page with the SAME
   * chunker extraction uses, embed the query + every chunk in ONE batch (no
   * completion calls), and keep the top-scoring chunks in document order.
   * Small pages return null (extract whole, as before); any failure degrades
   * to null too — focusing is an optimisation, never a gate.
   */
  private async focusExtractionText(query: string, text: string): Promise<string | null> {
    try {
      const chunks = chunkContent(text);
      if (chunks.length < FOCUS_MIN_CHUNKS) return null;
      const vectors = await this.gateway.embed([query, ...chunks.map((c) => c.text)]);
      const queryVector = vectors[0];
      if (!queryVector) return null;
      const kept = new Set(
        chunks
          .map((chunk) => ({
            index: chunk.index,
            score: cosineSimilarity(queryVector, vectors[chunk.index + 1] ?? []),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, FOCUS_TOP_CHUNKS)
          .map((s) => s.index),
      );
      this.log.log(
        `focused extraction: kept ${kept.size}/${chunks.length} chunks for one captured page`,
      );
      return chunks
        .filter((chunk) => kept.has(chunk.index))
        .map((chunk) => chunk.text)
        .join('\n\n');
    } catch (error) {
      this.log.warn(
        `focus_extraction_failed (falling back to the full page): ${
          error instanceof Error ? error.message : 'error'
        }`,
      );
      return null;
    }
  }

  /** Abort-window cleanup (the email-intake rule): the sweep is the backstop. */
  private async cleanupOrphanObject(objectKey: string): Promise<void> {
    for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await this.objects.deleteObject(objectKey);
        return;
      } catch {
        if (attempt === CLEANUP_ATTEMPTS) {
          this.log.warn(`orphan object left for the integrity sweep: ${objectKey}`);
        }
      }
    }
  }
}

/** Plain cosine over the gateway's embedding vectors (the focus pre-pass). */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? -1 : dot / denominator;
}
