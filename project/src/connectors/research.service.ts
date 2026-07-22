import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { MemoryScope, Principal, WebProcessingState } from '@cogeto/shared';
import {
  DailyCounters,
  deadLetter,
  DRIZZLE,
  jobExecution,
  RESEARCH_QUOTA,
  withTransactionalEnqueue,
} from '../infrastructure/index';
import type { Db, ResearchQuota } from '../infrastructure/index';
import { INGESTION_PIPELINE_JOB_TYPE } from '../ingestion/index';
import { MemoryObjectStore } from '../memory/index';
import { sanitizeHtml } from './email-parse';
import { webPage } from './persistence/tables';
import type { WebPageRow } from './persistence/tables';
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
  ) {}

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
  ): Promise<CaptureResult[]> {
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
            rawObjectKey,
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
