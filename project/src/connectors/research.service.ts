import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { MemoryScope, Principal, WebProcessingState } from '@cogeto/shared';
import {
  DailyCounters,
  deadLetter,
  DRIZZLE,
  jobExecution,
  RESEARCH_QUOTA,
  withTransactionalEnqueue,
  writeAudit,
} from '../infrastructure/index';
import type { Db, ResearchQuota } from '../infrastructure/index';
import { chunkContent, INGESTION_PIPELINE_JOB_TYPE } from '../ingestion/index';
import { MemoryObjectStore, MemoryStore } from '../memory/index';
import { ModelGateway } from '../model-gateway/index';
import { sanitizeHtml } from './email-parse';
import { minimiseQuery } from './research-minimise';
import { researchRun, webPage } from './persistence/tables';
import type { ResearchRunRow, WebPageRow } from './persistence/tables';
import { RESEARCH_OPTIONS } from './research-options';
import type { ResearchOptions } from './research-options';
import { WebDiscoveryService } from './web-discovery.service';
import type { DiscoveryOutcome } from './web-discovery.service';
import { WebFetchService } from './web-fetch';

/**
 * Web research (Priority 5 Part A; decisions 0042/0043): explicitly invoked,
 * never ambient. `search` runs one discovery query; `capture` fetches the URLs
 * the user selected and turns each page into a first-class web source — the
 * row, its domain event and its pipeline job commit together (§A.3), exactly
 * like a note or an email. Derived memories carry provenance
 * source_type = 'web' → web_page.id, and their temporal anchor is the fetch
 * time, so "as of when?" is always answerable.
 *
 * Budgets (the existing FIX-2 infrastructure): searches and fetched pages are
 * each capped per user per day, and one capture request is capped at
 * `pagesPerRunMax` pages — bounding both spend and blast radius before any
 * model work happens.
 */

/** One capture request's per-URL outcome — honest about every skip. */
export type CaptureResult =
  | { url: string; status: 'captured'; id: string; title: string | null }
  | { url: string; status: 'skipped'; reason: string; detail: string };

const CLEANUP_ATTEMPTS = 3;

/** The focused-extraction thresholds (decision 0057): pages splitting into
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
   * Open the gate (Part B, decisions 0044/0045): minimise the query and record
   * a PROPOSED run. Sends NOTHING — discovery runs only from `approve`. The
   * proposed query is the intent verbatim (chat strips its trigger verb first);
   * minimisation rewrites it to the least-identifying serving form.
   */
  async propose(principal: Principal, intent: string): Promise<ResearchRunRow> {
    const proposedQuery = intent.trim();
    const minimised = await minimiseQuery(this.gateway, intent, proposedQuery);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(researchRun)
        .values({
          ownerId: principal.userId,
          intent,
          proposedQuery,
          minimisedQuery: minimised.minimised,
          minimiseReason: minimised.reason,
        })
        .returning();
      // Structural audit only (QS-1): the transition, never the query text —
      // the text lives on the owner-gated run row itself.
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'research_run.proposed',
        entityType: 'research_run',
        entityId: row!.id,
        orgId: principal.orgId,
        ownerId: principal.userId,
      });
      return row!;
    });
  }

  /**
   * The ONLY path to discovery (decision 0045): explicit approval records the
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
    const sentQuery = query.trim();
    if (!sentQuery) throw new ConflictException('the approved query must not be blank');
    const run = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(researchRun)
        .where(and(eq(researchRun.id, runId), eq(researchRun.ownerId, principal.userId)))
        .for('update');
      const row = rows[0];
      if (!row) throw new NotFoundException();
      if (row.status === 'cancelled') {
        throw new ConflictException('this research was cancelled — propose it again');
      }
      if (row.status === 'approved') {
        if (row.sentQuery !== sentQuery) {
          throw new ConflictException(
            'this research already ran with a different approved query — propose a new one',
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
      });
      return updated!;
    });
    const search = await this.search(principal, sentQuery);
    return { run, search };
  }

  /** Cancel at the gate: nothing was sent, nothing will be. Idempotent. */
  async cancel(principal: Principal, runId: string): Promise<ResearchRunRow> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(researchRun)
        .where(and(eq(researchRun.id, runId), eq(researchRun.ownerId, principal.userId)))
        .for('update');
      const row = rows[0];
      if (!row) throw new NotFoundException();
      if (row.status === 'cancelled') return row;
      if (row.status === 'approved') {
        throw new ConflictException('this research already ran — its query has left');
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
      });
      return updated!;
    });
  }

  async getRun(principal: Principal, runId: string): Promise<ResearchRunRow | null> {
    const rows = await this.db
      .select()
      .from(researchRun)
      .where(and(eq(researchRun.id, runId), eq(researchRun.ownerId, principal.userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** System read for the worker's conclusion job (decision 0057) — no
   * principal exists there; the row's own ownerId scopes everything after. */
  async getRunById(runId: string): Promise<ResearchRunRow | null> {
    const rows = await this.db.select().from(researchRun).where(eq(researchRun.id, runId)).limit(1);
    return rows[0] ?? null;
  }

  async listRuns(principal: Principal, limit = 50): Promise<ResearchRunRow[]> {
    return this.db
      .select()
      .from(researchRun)
      .where(eq(researchRun.ownerId, principal.userId))
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
   * The in-chat flow's honest wait (decision 0047): each captured page's
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
    if (!run) throw new NotFoundException();
    const pages = await this.pagesForRun(principal, runId);
    return Promise.all(
      pages.map(async (page) => ({
        id: page.id,
        url: page.finalUrl,
        title: page.title,
        state: await this.getProcessingState(page.id),
        factCount: this.memories
          ? (await this.memories.listBySourceSystem('web', page.id)).length
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
    if (this.counters.get(principal.userId, 'research_search') >= this.quota.searchesMax) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: 'daily_research_limit',
          message: `daily research search limit reached (${this.quota.searchesMax}) — try again tomorrow`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.counters.add(principal.userId, 'research_search', 1);
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
      if (!run) throw new NotFoundException();
      if (run.status !== 'approved') {
        throw new ConflictException('capture requires an approved research run');
      }
    }
    if (urls.length > this.quota.pagesPerRunMax) {
      throw new HttpException(
        {
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          code: 'research_page_cap',
          message: `a single research fetches at most ${this.quota.pagesPerRunMax} pages`,
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    const results: CaptureResult[] = [];
    for (const url of urls) {
      if (this.counters.get(principal.userId, 'research_page') >= this.quota.pagesMax) {
        results.push({
          url,
          status: 'skipped',
          reason: 'limit_reached',
          detail: `daily research page limit reached (${this.quota.pagesMax}) — try again tomorrow`,
        });
        continue;
      }
      // Reserved BEFORE the fetch (the notes-quota rule): a failed fetch still
      // consumed outbound work, so it still counts.
      this.counters.add(principal.userId, 'research_page', 1);
      const outcome = await this.fetcher.fetchPage(url);
      if (outcome.status === 'skipped') {
        results.push({ url, status: 'skipped', reason: outcome.reason, detail: outcome.detail });
        continue;
      }
      const { page } = outcome;
      const id = randomUUID();

      // Optional raw-HTML retention (decision 0043): sanitised (scripts and
      // handlers stripped — the email-intake rule) and object-first, so the tx
      // below can reference the key knowing the bytes exist.
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

      // The focused extraction view (decision 0057): rank the page's chunks
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
      .where(and(eq(webPage.id, id), eq(webPage.ownerId, principal.userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Processing state from the queue's own ledgers — the notes-source rule. */
  async getProcessingState(id: string): Promise<WebProcessingState> {
    const done = await this.db
      .select({ id: jobExecution.id })
      .from(jobExecution)
      .where(
        and(
          eq(jobExecution.sourceType, 'web'),
          eq(jobExecution.sourceId, id),
          eq(jobExecution.jobType, INGESTION_PIPELINE_JOB_TYPE),
        ),
      )
      .limit(1);
    if (done.length > 0) return 'done';

    const failed = await this.db
      .select({ id: deadLetter.id })
      .from(deadLetter)
      .where(
        and(
          eq(deadLetter.jobType, INGESTION_PIPELINE_JOB_TYPE),
          sql`${deadLetter.payload}->>'source_id' = ${id}`,
        ),
      )
      .limit(1);
    return failed.length > 0 ? 'failed' : 'processing';
  }

  /**
   * Persist the synthesised answer and conclude the run (decision 0057) —
   * the terminal success state. `seen` marks the answer acknowledged in the
   * same write (the interactive path: the user is watching it render).
   */
  async recordConclusion(runId: string, answer: string, opts: { seen: boolean }): Promise<void> {
    const now = new Date();
    await this.db
      .update(researchRun)
      .set({
        answer,
        status: 'concluded',
        concludedAt: now,
        ...(opts.seen ? { answerSeenAt: now } : {}),
      })
      .where(eq(researchRun.id, runId));
  }

  /** The owner saw the stored answer — the chat resume surface stops showing
   * this run (decision 0057). Idempotent. */
  async markAnswerSeen(principal: Principal, runId: string): Promise<void> {
    const run = await this.getRun(principal, runId);
    if (!run) throw new NotFoundException();
    if (run.answerSeenAt) return;
    await this.db
      .update(researchRun)
      .set({ answerSeenAt: new Date() })
      .where(eq(researchRun.id, runId));
  }

  /**
   * The relevance pre-pass (decision 0057): split the page with the SAME
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
