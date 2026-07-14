import { Injectable } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import type {
  ChatReplyCandidate,
  ChatReplyDraftResult,
  ChatReplyResolverPort,
} from '../retrieval/index';
import { EmailSourceService } from './email-source.service';
import { EmailReplyDraftService } from './email-reply-draft.service';

/**
 * The connectors implementation of retrieval's chat → email-reply seam (Session
 * O4). ChatService resolves a "draft a reply to Ana" request through this port
 * without importing connectors: it finds the candidate emails and, on a
 * confident match, creates the draft through the existing approval path. Never
 * sends — `createDraft` only produces a pending approval. Composed only into the
 * app root (via EmailReplyModule).
 */
@Injectable()
export class ChatReplyResolver implements ChatReplyResolverPort {
  constructor(
    private readonly emails: EmailSourceService,
    private readonly drafts: EmailReplyDraftService,
  ) {}

  async findCandidates(principal: Principal, name: string | null): Promise<ChatReplyCandidate[]> {
    const candidates = await this.emails.findReplyCandidates(principal, name);
    return candidates.map((c) => ({
      emailId: c.emailId,
      from: c.from,
      subject: c.subject,
      receivedAt: c.receivedAt,
    }));
  }

  async createDraft(principal: Principal, emailId: string): Promise<ChatReplyDraftResult> {
    const { approval, to, recipientResolved } = await this.drafts.draftReply(principal, emailId);
    return { approvalId: approval.id, to, recipientResolved };
  }
}
