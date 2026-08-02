import type { ChatStreamEvent, Principal } from '@cogeto/shared';
import { serverT } from '../../infrastructure/index';
import type { ChatSkillResolverPort } from '../chat-skill-resolver.port';
import type { ChatTurnSink } from './intent-plumbing';

/**
 * The skill-brief opener (V2.0 item 3.6 part 4, extracted verbatim from
 * chat.service.ts): start planning — gather from memory, propose the query
 * plan — and hand the user the run view, where the plan gate lives.
 * Deterministic confirmation text; an ambiguous subject asks and creates
 * nothing.
 */
export class SkillBriefHandler {
  constructor(
    private readonly resolver: ChatSkillResolverPort,
    private readonly sink: ChatTurnSink,
  ) {}

  async *handle(
    principal: Principal,
    conversationId: string,
    subject: string,
    lang: 'en' | 'hr',
  ): AsyncGenerator<ChatStreamEvent> {
    yield { type: 'sources', facts: [] };
    let answer: string;
    let runRef: { runId: string } | null = null;
    try {
      const proposal = await this.resolver.propose(principal, subject);
      if (proposal.status === 'ambiguous') {
        const list = proposal.candidates.map((c, i) => `${i + 1}. ${c}`).join('\n');
        answer = serverT(lang, 'chat', 'skillBrief.ambiguous', { candidates: list });
      } else {
        runRef = { runId: proposal.runId };
        answer = serverT(lang, 'chat', 'skillBrief.preparing', {
          subject,
          count: proposal.queryCount,
        });
      }
    } catch (error) {
      this.sink.logWarn(`skill_intent_failed: ${error instanceof Error ? error.message : 'error'}`);
      answer = serverT(lang, 'chat', 'skillBrief.failed');
    }
    yield { type: 'token', text: answer };
    const row = await this.sink.storeAssistant(principal, conversationId, answer);
    yield {
      type: 'done',
      messageId: row.id,
      content: answer,
      citationViolations: 0,
      skillRun: runRef,
    };
  }
}
