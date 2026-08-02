import type { ChatStreamEvent, PreferredLanguage, Principal } from '@cogeto/shared';
import { LOCALE_TAGS } from '@cogeto/shared';
import { serverTranslator } from '../../infrastructure/index';
import type { ChatReplyResolverPort } from '../chat-reply-resolver.port';
import type { ChatTurnSink } from './intent-plumbing';

/**
 * The draft-a-reply chat flow (V2.0 item 3.6 part 4, extracted verbatim from
 * chat.service.ts). Resolve the target email against the owner's recent
 * emails, then act like a thoughtful assistant:
 *  - 0 matches      → say so, point to the drawer's "Draft reply".
 *  - >1 for a NAMED target → list the candidates and ask which (create nothing).
 *  - 1 (or "the last one") → create the draft via the approval path and confirm
 *    with a link. Cogeto never sends. No retrieval-answer, no ingestion work.
 */
export class ReplyIntentHandler {
  constructor(
    private readonly resolver: ChatReplyResolverPort,
    private readonly sink: ChatTurnSink,
  ) {}

  async *handle(
    principal: Principal,
    conversationId: string,
    target: string | null,
    lang: PreferredLanguage,
  ): AsyncGenerator<ChatStreamEvent> {
    yield { type: 'sources', facts: [] };
    const t = serverTranslator(lang, 'chat');
    let answer: string;
    try {
      const candidates = await this.resolver.findCandidates(principal, target);
      if (candidates.length === 0) {
        answer = target ? t('reply.noneForTarget', { target }) : t('reply.noneAtAll');
      } else if (target && candidates.length > 1) {
        const list = candidates
          .map((c, i) =>
            t('reply.candidateLine', {
              index: i + 1,
              from: c.from,
              subject: c.subject ?? t('reply.noSubject'),
              date: formatCandidateDate(c.receivedAt, lang),
            }),
          )
          .join('\n');
        answer = t('reply.ambiguous', { target, candidates: list });
      } else {
        const draft = await this.resolver.createDraft(principal, candidates[0]!.emailId);
        answer = draft.recipientResolved
          ? t('reply.drafted', { recipient: draft.to })
          : t('reply.draftedUnknownRecipient');
      }
    } catch (error) {
      this.sink.logWarn(`reply_intent_failed: ${error instanceof Error ? error.message : 'error'}`);
      answer = t('reply.failed');
    }

    yield { type: 'token', text: answer };
    const row = await this.sink.storeAssistant(principal, conversationId, answer);
    yield { type: 'done', messageId: row.id, content: answer, citationViolations: 0 };
  }
}

/**
 * The date beside a candidate email, in the READER'S locale (V2.0 item 3.5,
 * Issue C). It used to follow whatever locale the server process happened to
 * have, which is nobody's choice.
 */
function formatCandidateDate(iso: string | Date, lang: PreferredLanguage): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[lang]).format(new Date(iso));
}
