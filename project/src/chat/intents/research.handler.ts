import type { ChatStreamEvent, Principal } from '@cogeto/shared';
import { serverT } from '../../infrastructure/index';
import type { ChatResearchResolverPort } from '../chat-research-resolver.port';
import type { ChatTurnSink } from './intent-plumbing';

/**
 * The research gate opener (V2.0 item 3.6 part 4, extracted verbatim from
 * chat.service.ts): minimise the query and record a PROPOSED run — the
 * deterministic confirmation states plainly that nothing has been sent and
 * points at the Research page, where the user edits/approves/cancels. The
 * confirmation is deterministic text except the disclosed query itself.
 */
export class ResearchIntentHandler {
  constructor(
    private readonly resolver: ChatResearchResolverPort,
    private readonly sink: ChatTurnSink,
  ) {}

  async *handle(
    principal: Principal,
    conversationId: string,
    topic: string,
    lang: 'en' | 'hr',
  ): AsyncGenerator<ChatStreamEvent> {
    yield { type: 'sources', facts: [] };
    let answer: string;
    // The inline gate's handle: lets the chat surface open the
    // SAME gate in place. Null when proposing failed.
    let proposalRef: { runId: string } | null = null;
    try {
      const proposal = await this.resolver.propose(principal, topic, conversationId);
      proposalRef = { runId: proposal.runId };
      answer = serverT(lang, 'chat', 'research.prepared', {
        query: proposal.minimisedQuery,
        reason: proposal.minimiseReason,
      });
    } catch (error) {
      this.sink.logWarn(
        `research_intent_failed: ${error instanceof Error ? error.message : 'error'}`,
      );
      answer = serverT(lang, 'chat', 'research.failed');
    }
    yield { type: 'token', text: answer };
    const row = await this.sink.storeAssistant(principal, conversationId, answer);
    yield {
      type: 'done',
      messageId: row.id,
      content: answer,
      citationViolations: 0,
      researchProposal: proposalRef,
    };
  }
}
