import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Principal, ResearchAnswerDto, ResearchCitationDto } from '@cogeto/shared';
import {
  buildContextBlock,
  DEFAULT_INSTANCE_TIMEZONE,
  EMPTY_USER_CONTEXT,
  INSTANCE_TIMEZONE,
  UserContextService,
} from '../infrastructure/index';
import { loadPrompt, ModelGateway } from '../model-gateway/index';
import type { PromptArtifact } from '../model-gateway/index';
import { CONVERSATION_APPEND, RetrievalService } from '../retrieval/index';
import type { ConversationAppendPort } from '../retrieval/index';
import { ResearchService } from './research.service';
import type { ResearchRunRow, WebPageRow } from './persistence/tables';

/**
 * Sourced synthesis (Priority 5 Part B, decision 0045): the answer step of a
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

export const RESEARCH_ANSWER_PROMPT = { family: 'research_answer', version: 'v0003' };

/** Caps that bound one synthesis call: pages and per-page excerpt length. */
const MAX_PAGES = 8;
const PAGE_EXCERPT_CHARS = 6000;
const MAX_MEMORY_FACTS = 6;

@Injectable()
export class ResearchSynthesisService {
  private prompt?: PromptArtifact;

  constructor(
    private readonly research: ResearchService,
    /** Absent in the WORKER composition (decision 0057): server-side
     * conclusion synthesises web-only ([W#] citations); the interactive app
     * path always has it, so memory claims still cite memories there. */
    @Optional()
    private readonly retrieval: RetrievalService | undefined,
    private readonly gateway: ModelGateway,
    /** Per-user context + language (P6.6). Absent in bare test harnesses. */
    @Optional()
    private readonly userContext?: UserContextService,
    @Optional()
    @Inject(INSTANCE_TIMEZONE)
    private readonly instanceTimeZone: string = DEFAULT_INSTANCE_TIMEZONE,
    /** The conversation-append seam (issue #259; retrieval owns it): where a
     * chat-invoked run's concluded answer lands as a persistent message. */
    @Optional()
    @Inject(CONVERSATION_APPEND)
    private readonly conversationAppend?: ConversationAppendPort,
  ) {}

  async synthesise(principal: Principal, runId: string): Promise<ResearchAnswerDto> {
    const run = await this.research.getRun(principal, runId);
    if (!run) throw new NotFoundException();
    const pages = (await this.research.pagesForRun(principal, runId)).slice(0, MAX_PAGES);
    // A concluded run replays its STORED answer (decision 0057) — the worker
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
    // delivers into the conversation (issue #259).
    const won = await this.research.recordConclusion(runId, result.answer, { seen: true });
    if (won) await this.deliverToConversation(run, result);
    return result;
  }

  /**
   * The worker's conclusion (decision 0057): runs when the last captured page
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
    // Delivered into its conversation counts as seen (issue #259): the answer
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
      contextRecord.preferredLanguage === 'hr' ? 'hr' : 'en',
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

    const webBlocks = pages.map((page, i) => {
      const fetched = page.fetchedAt.toISOString().slice(0, 10);
      return (
        `[W${i + 1}] ${page.title ?? '(untitled page)'}\n` +
        `url: ${page.finalUrl}\nfetched: ${fetched}\n` +
        `text:\n${page.retainedText.slice(0, PAGE_EXCERPT_CHARS)}`
      );
    });
    const factBlocks = memories.map(
      (m, i) => `[M${i + 1}] ${m.memory.content ?? '(withheld)'} (status: ${m.memory.status})`,
    );

    // The now-block (P6.6): the clock for fetch-date freshness plus the
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
 * The thread form of a concluded answer (issue #259): memory markers become
 * canonical {{cite:<uuid>}} chips the chat renderer resolves; web markers
 * become numbered references with a Sources block naming title, URL and fetch
 * date. The literals follow the user's language anchor (decision 0052).
 */
export function buildThreadMessage(
  answer: string,
  citations: ResearchCitationDto[],
  language: 'en' | 'hr',
): string {
  const byMarker = new Map(citations.map((c) => [c.marker, c]));
  const webOrder: Extract<ResearchCitationDto, { kind: 'web' }>[] = [];
  const text = answer.replace(/\[([WM])(\d+)\]/g, (whole) => {
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
  const sources = webOrder.map((c, i) => {
    const fetched = c.fetchedAt.slice(0, 10);
    return `${i + 1}. ${c.title ?? c.url} (${c.url}, ${language === 'hr' ? 'dohvaćeno' : 'fetched'} ${fetched})`;
  });
  return [
    text.trim(),
    ...(sources.length > 0 ? ['', language === 'hr' ? 'Izvori:' : 'Sources:', ...sources] : []),
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
