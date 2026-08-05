import type { ChatStreamEvent, Principal } from '@cogeto/shared';
import { serverT } from '../../infrastructure/index';
import type { ModelGateway } from '../../model-gateway/index';
import type { ConversationTurn, SmallTalkIntent } from '../../retrieval/index';
import { buildSmallTalkInput, toStoredAnswer } from '../answer-prompt';
import type { ChatTurnSink } from './intent-plumbing';

/**
 * The two small-talk arms (V2.0 item 3.6 part 4, extracted verbatim from
 * chat.service.ts):
 *
 * - `handleLexicon`: deterministic small talk — a pure pleasantry gets a
 *   natural reply in the matched language. No retrieval, no model call, no
 *   citation theatre; the words come from the server catalogue.
 * - `handleModel`: model-classified small talk / meta beyond the lexicon
 *   ("what can you do?") — a brief answer-tier reply with the recent turns
 *   for tone; no retrieval, and the sanitizer still guarantees no marker can
 *   leak.
 */
export class SmallTalkHandler {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly sink: ChatTurnSink,
  ) {}

  async *handleLexicon(
    principal: Principal,
    conversationId: string,
    intent: SmallTalkIntent,
  ): AsyncGenerator<ChatStreamEvent> {
    yield { type: 'sources', facts: [] };
    // Small talk mirrors the matched language of the turn (unchanged); the
    // words come from the server catalogue (V2.0 item 3.5). The KIND is the
    // detector's value and is never translated, only its reply is.
    const answer = serverT(intent.lang, 'chat', `smallTalk.${intent.kind}`);
    yield { type: 'token', text: answer };
    const row = await this.sink.storeAssistant(principal, conversationId, answer);
    yield { type: 'done', messageId: row.id, content: answer, citationViolations: 0 };
  }

  async *handleModel(
    principal: Principal,
    conversationId: string,
    content: string,
    history: ConversationTurn[],
    contextBlock?: string,
    thinkingMode: 'on' | 'off' = 'on',
  ): AsyncGenerator<ChatStreamEvent> {
    yield { type: 'sources', facts: [] };
    const prompt = await this.sink.getPrompt();
    let buffer = '';
    let thinking = '';
    const stream = this.gateway.completeStream({
      system: prompt.content,
      input: buildSmallTalkInput(history, content, contextBlock),
      tier: 'answer',
      thinking: thinkingMode,
    });
    for await (const delta of stream) {
      if (delta.channel === 'thinking') {
        thinking += delta.text;
        yield { type: 'thinking', text: delta.text };
        continue;
      }
      buffer += delta.text;
      yield { type: 'token', text: delta.text };
    }
    const { text: stored, violations } = toStoredAnswer(buffer, []);
    if (violations > 0) {
      this.sink.logWarn(`citation_violation stripped=${violations}`);
    }
    const row = await this.sink.storeAssistant(
      principal,
      conversationId,
      stored,
      thinking.trim() ? thinking : null,
    );
    yield { type: 'done', messageId: row.id, content: stored, citationViolations: violations };
  }
}
