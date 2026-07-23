import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Principal, ResearchAnswerDto, ResearchCitationDto } from '@cogeto/shared';
import { loadPrompt, ModelGateway } from '../model-gateway/index';
import type { PromptArtifact } from '../model-gateway/index';
import { RetrievalService } from '../retrieval/index';
import { ResearchService } from './research.service';
import type { WebPageRow } from './persistence/tables';

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

export const RESEARCH_ANSWER_PROMPT = { family: 'research_answer', version: 'v0002' };

/** Caps that bound one synthesis call: pages and per-page excerpt length. */
const MAX_PAGES = 8;
const PAGE_EXCERPT_CHARS = 6000;
const MAX_MEMORY_FACTS = 6;

@Injectable()
export class ResearchSynthesisService {
  private prompt?: PromptArtifact;

  constructor(
    private readonly research: ResearchService,
    private readonly retrieval: RetrievalService,
    private readonly gateway: ModelGateway,
  ) {}

  async synthesise(principal: Principal, runId: string): Promise<ResearchAnswerDto> {
    const run = await this.research.getRun(principal, runId);
    if (!run) throw new NotFoundException();
    if (run.status !== 'approved') {
      throw new UnprocessableEntityException('synthesis needs an approved research run');
    }
    const pages = (await this.research.pagesForRun(principal, runId)).slice(0, MAX_PAGES);
    if (pages.length === 0) {
      throw new UnprocessableEntityException('capture at least one page before synthesising');
    }

    // Remembered facts join the sources so memory claims cite memories —
    // retrieval is scope-gated as always; failures degrade to web-only.
    const memories = await this.retrieval
      .retrieve(principal, run.intent)
      .then((result) => result.memories.slice(0, MAX_MEMORY_FACTS))
      .catch(() => []);

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

    this.prompt ??= await loadPrompt(RESEARCH_ANSWER_PROMPT.family, RESEARCH_ANSWER_PROMPT.version);
    const raw = await this.gateway.complete({
      system: this.prompt.content,
      input:
        `QUESTION:\n${run.intent}\n\n` +
        `WEB SOURCES:\n${webBlocks.join('\n\n') || '(none)'}\n\n` +
        `KNOWN FACTS:\n${factBlocks.join('\n') || '(none)'}`,
      tier: 'answer',
    });

    const { answer, citations } = resolveMarkers(raw.text, pages, memories);
    await this.research.recordAnswer(runId, answer);
    return { runId, answer, citations };
  }
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
