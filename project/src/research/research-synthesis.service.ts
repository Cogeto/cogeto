import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  PreferredLanguage,
  Principal,
  ResearchAnswerDto,
  ResearchCitationDto,
} from '@cogeto/shared';
import { RESEARCH_MARKER_CAPTURING } from '@cogeto/shared';
import {
  buildContextBlock,
  DEFAULT_INSTANCE_TIMEZONE,
  EMPTY_USER_CONTEXT,
  serverTranslator,
  UserContextService,
} from '../infrastructure/index';
import {
  fenceUntrusted,
  loadPrompt,
  ModelGateway,
  untrustedBoundary,
} from '../model-gateway/index';
import type { PromptArtifact } from '../model-gateway/index';
import { RetrievalService } from '../retrieval/index';
import type { ConversationAppendPort } from '../chat/index';
import { ResearchService } from './research.service';
import type { ResearchRunRow, WebPageRow } from './persistence/tables';

/**
 * Sourced synthesis: the answer step of a
 * research run, on the ANSWER tier — the only research stage that uses it.
 * Per-claim provenance is the contract: [W#] markers cite fetched pages (URL +
 * fetch time), [M#] markers cite remembered facts, and model knowledge is
 * marked (unsourced) by the prompt. Composed only into the app root
 * (ResearchChatModule) because it needs RetrievalService — the same seam shape
 * as EmailReplyDraftService.
 *
 * Unknown markers are stripped before storing (the chat answers' sanitize
 * rule): a citation the reader cannot resolve to a supplied source never
 * survives into the record.
 */

export const RESEARCH_ANSWER_PROMPT = { family: 'research_answer', version: 'v0004' };

/** Caps that bound one synthesis call: pages and per-page excerpt length. */
const MAX_PAGES = 8;
const PAGE_EXCERPT_CHARS = 6000;
const MAX_MEMORY_FACTS = 6;

/**
 * ResearchSynthesisService's optional collaborators, by NAME (V2.0 item 3.6
 * part 4). The old constructor was the hazard at its worst: an `@Optional()`
 * parameter sat BETWEEN two required ones, so a manual construction that
 * dropped it shifted every later argument one place left, silently.
 */
export interface ResearchSynthesisOptions {
  /** Absent in the WORKER composition: server-side conclusion synthesises
   * web-only ([W#] citations); the interactive app path always has it, so
   * memory claims still cite memories there. */
  retrieval?: RetrievalService;
  /** Per-user context + language. Absent in bare test harnesses. */
  userContext?: UserContextService;
  instanceTimeZone?: string;
  /** The conversation-append seam (retrieval owns it): where a
   * chat-invoked run's concluded answer lands as a persistent message. */
  conversationAppend?: ConversationAppendPort;
}

export const RESEARCH_SYNTHESIS_OPTIONS = Symbol('RESEARCH_SYNTHESIS_OPTIONS');

@Injectable()
export class ResearchSynthesisService {
  private prompt?: PromptArtifact;
  private readonly retrieval?: RetrievalService;
  private readonly userContext?: UserContextService;
  private readonly instanceTimeZone: string;
  private readonly conversationAppend?: ConversationAppendPort;

  constructor(
    private readonly research: ResearchService,
    private readonly gateway: ModelGateway,
    /** Every optional collaborator, by NAME — see ResearchSynthesisOptions. */
    @Optional() @Inject(RESEARCH_SYNTHESIS_OPTIONS) options?: ResearchSynthesisOptions,
  ) {
    this.retrieval = options?.retrieval;
    this.userContext = options?.userContext;
    this.instanceTimeZone = options?.instanceTimeZone ?? DEFAULT_INSTANCE_TIMEZONE;
    this.conversationAppend = options?.conversationAppend;
  }

  async synthesise(principal: Principal, runId: string): Promise<ResearchAnswerDto> {
    const run = await this.research.getRun(principal, runId);
    if (!run) throw new NotFoundException();
    const pages = (await this.research.pagesForRun(principal, runId)).slice(0, MAX_PAGES);
    // A concluded run replays its STORED answer — the worker
    // may have finished while nobody was watching; asking again re-resolves
    // the web citations without another model call.
    if (run.status === 'concluded' && run.answer) {
      await this.research.markAnswerSeen(principal, runId);
      const { answer, citations } = resolveMarkers(run.answer, pages, []);
      return { runId, answer, citations };
    }
    if (run.status !== 'approved') {
      throw new UnprocessableEntityException('synthesis needs an approved research run');
    }
    if (pages.length === 0) {
      throw new UnprocessableEntityException('capture at least one page before synthesising');
    }
    const result = await this.synthesiseCore(principal, runId, run.intent, pages);
    // Interactive path: the user is watching the answer render — seen now.
    // The guarded write races the worker's conclusion; only the winner
    // delivers into the conversation.
    const won = await this.research.recordConclusion(runId, result.answer, { seen: true });
    if (won) await this.deliverToConversation(run, result);
    return result;
  }

  /**
   * The worker's conclusion: runs when the last captured page
   * settles, whether or not anyone is watching. Idempotent by construction —
   * only an 'approved' run concludes, and 'concluded' is terminal. Retrieval
   * is absent in the worker, so the stored answer cites pages ([W#]) only.
   */
  async concludeRun(runId: string): Promise<{ concluded: boolean }> {
    const run = await this.research.getRunById(runId);
    if (!run || run.status !== 'approved') return { concluded: false };
    const owner: Principal = {
      userId: run.ownerId,
      name: '',
      email: null,
      orgId: '',
      orgName: '',
      roles: [],
    };
    const pages = (await this.research.pagesForRun(owner, runId)).slice(0, MAX_PAGES);
    if (pages.length === 0) return { concluded: false };
    const result = await this.synthesiseCore(owner, runId, run.intent, pages);
    // Delivered into its conversation counts as seen: the answer
    // is a persistent message in the thread, not a pending surface.
    const won = await this.research.recordConclusion(runId, result.answer, {
      seen: run.conversationId !== null,
    });
    if (won) await this.deliverToConversation(run, result);
    return { concluded: won };
  }

  /**
   * Lands a concluded answer in the conversation it was invoked from (issue
   * #259) — automatically, as a persistent assistant message: [M#] markers
   * become real citation chips, [W#] markers become numbered entries in a
   * Sources block. Research-page runs (no conversation) skip this; a deleted
   * conversation skips silently (the answer stays on the run).
   */
  private async deliverToConversation(
    run: ResearchRunRow,
    result: ResearchAnswerDto,
  ): Promise<void> {
    if (!run.conversationId || !this.conversationAppend) return;
    const contextRecord = await Promise.resolve(this.userContext?.get(run.ownerId))
      .then((record) => record ?? EMPTY_USER_CONTEXT)
      .catch(() => EMPTY_USER_CONTEXT);
    const content = buildThreadMessage(
      result.answer,
      result.citations,
      contextRecord.preferredLanguage,
    );
    await this.conversationAppend
      .append(run.ownerId, run.conversationId, content)
      .catch(() => undefined);
  }

  private async synthesiseCore(
    principal: Principal,
    runId: string,
    intent: string,
    pages: WebPageRow[],
  ): Promise<ResearchAnswerDto> {
    // Remembered facts join the sources so memory claims cite memories —
    // retrieval is scope-gated as always; failures (or the worker's absent
    // retrieval) degrade to web-only.
    const memories = this.retrieval
      ? await this.retrieval
          .retrieve(principal, intent)
          .then((result) => result.memories.slice(0, MAX_MEMORY_FACTS))
          .catch(() => [])
      : [];

    // SEC-4: a fetched page is the most hostile input in the product, and its
    // title and body are both attacker-authored. Marker, url and fetch date
    // stay outside the fence so citation resolution is unaffected.
    const boundary = untrustedBoundary();
    const webBlocks = pages.map((page, i) => {
      const fetched = page.fetchedAt.toISOString().slice(0, 10);
      return (
        `[W${i + 1}] url: ${page.finalUrl}\nfetched: ${fetched}\n` +
        `title and text:\n` +
        fenceUntrusted(
          `${page.title ?? '(untitled page)'}\n${page.retainedText.slice(0, PAGE_EXCERPT_CHARS)}`,
          boundary,
        )
      );
    });
    const factBlocks = memories.map(
      (m, i) =>
        `[M${i + 1}] (status: ${m.memory.status})\n` +
        fenceUntrusted(m.memory.content ?? '(withheld)', boundary),
    );

    // The now-block: the clock for fetch-date freshness plus the
    // reply-language rule. Any context-read failure degrades to no block.
    const contextRecord = await Promise.resolve(this.userContext?.get(principal.userId))
      .then((record) => record ?? EMPTY_USER_CONTEXT)
      .catch(() => EMPTY_USER_CONTEXT);
    const contextBlock = buildContextBlock(
      contextRecord,
      new Date(),
      contextRecord.timezone ?? this.instanceTimeZone,
      { language: true },
    );

    this.prompt ??= await loadPrompt(RESEARCH_ANSWER_PROMPT.family, RESEARCH_ANSWER_PROMPT.version);
    const raw = await this.gateway.complete({
      system: this.prompt.content,
      input:
        `${contextBlock}\n\n` +
        `QUESTION:\n${intent}\n\n` +
        `WEB SOURCES:\n${webBlocks.join('\n\n') || '(none)'}\n\n` +
        `KNOWN FACTS:\n${factBlocks.join('\n') || '(none)'}`,
      tier: 'answer',
    });

    const { answer, citations } = resolveMarkers(raw.text, pages, memories);
    return { runId, answer, citations };
  }
}

/**
 * The thread form of a concluded answer: memory markers become
 * canonical {{cite:<uuid>}} chips the chat renderer resolves; web markers
 * become numbered references with a Sources block naming title, URL and fetch
 * date. The literals follow the user's language anchor.
 */
export function buildThreadMessage(
  answer: string,
  citations: ResearchCitationDto[],
  language: PreferredLanguage,
): string {
  const byMarker = new Map(citations.map((c) => [c.marker, c]));
  const webOrder: Extract<ResearchCitationDto, { kind: 'web' }>[] = [];
  const text = answer.replace(new RegExp(RESEARCH_MARKER_CAPTURING, 'g'), (whole) => {
    const cite = byMarker.get(whole);
    if (!cite) return '';
    if (cite.kind === 'memory') return `{{cite:${cite.memoryId}}}`;
    let at = webOrder.findIndex((c) => c.marker === whole);
    if (at === -1) {
      webOrder.push(cite);
      at = webOrder.length - 1;
    }
    return `[${at + 1}]`;
  });
  const t = serverTranslator(language, 'research');
  const sources = webOrder.map((c, i) =>
    t('thread.sourceLine', {
      index: i + 1,
      title: c.title ?? c.url,
      url: c.url,
      date: c.fetchedAt.slice(0, 10),
    }),
  );
  return [
    text.trim(),
    ...(sources.length > 0 ? ['', t('thread.sourcesHeading'), ...sources] : []),
  ].join('\n');
}

/**
 * Keep only markers that resolve to a supplied source; strip the rest (they
 * count as violations of the grounding contract, exactly as chat treats an
 * invented cite). Returns the sanitised answer and its resolved citations in
 * order of first appearance.
 */
function resolveMarkers(
  text: string,
  pages: WebPageRow[],
  memories: { memory: { id: string } }[],
): { answer: string; citations: ResearchCitationDto[] } {
  const seen = new Map<string, ResearchCitationDto>();
  const answer = text
    .replace(new RegExp(RESEARCH_MARKER_CAPTURING, 'g'), (whole, kind: string, num: string) => {
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
      const memory = memories[index];
      if (!memory) return '';
      seen.set(whole, { kind: 'memory', marker: whole, memoryId: memory.memory.id });
      return whole;
    })
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { answer, citations: [...seen.values()] };
}
