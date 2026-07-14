import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { ApprovalDto, Principal } from '@cogeto/shared';
import { EMAIL_REPLY_DRAFT_ACTION } from '@cogeto/shared';
import type { EmailReplyDraftPayload } from '@cogeto/shared';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { isolateEmailContent } from '../ingestion/index';
import { ModelGateway } from '../model-gateway/index';
import { RetrievalService } from '../retrieval/index';
import { ApprovalService } from '../agents/index';
import { emailMessage } from './persistence/tables';

/** How many context facts the drafter is grounded on. */
const CONTEXT_TOP_K = 10;

/**
 * The reply-drafting system prompt. NOT a memory-deciding prompt (it drafts an
 * outbound message, never decides what to remember), so it is an inline constant
 * rather than a versioned golden-set artifact (§B.7 governs memory-deciding
 * prompts). Grounds the draft strictly in the retrieved context so the model
 * never invents commitments the user has not made.
 */
const REPLY_DRAFT_SYSTEM = [
  'You draft a concise, professional email reply on behalf of the user.',
  'Ground the reply ONLY in the ORIGINAL MESSAGE and the CONTEXT FACTS provided.',
  'Do NOT invent commitments, dates, numbers, or names that are not in the context.',
  'If the context is thin, keep the reply brief and non-committal.',
  'Output ONLY the reply body text — no subject line, no "To:"/"From:" headers,',
  'no code fences. A short greeting and sign-off are fine.',
].join(' ');

/**
 * Drafts a reply to an email as a consequential action in the approval machine
 * (Session O4 — email source). This is the "draft a reply to Ana's last message"
 * capability reachable from chat / the email surface: retrieval assembles context
 * (what the user knows about the sender, open loops), the answer tier drafts the
 * reply, and the result becomes an `email_reply_draft` approval. Cogeto never
 * sends — approval finalises the draft for the user to send from their own client.
 *
 * Lives in connectors (it owns email_message) but is composed ONLY into the app
 * root (it needs RetrievalService + ApprovalService, app-only), never the worker.
 */
@Injectable()
export class EmailReplyDraftService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly retrieval: RetrievalService,
    private readonly gateway: ModelGateway,
    private readonly approvals: ApprovalService,
  ) {}

  async draftReply(principal: Principal, emailId: string): Promise<ApprovalDto> {
    const rows = await this.db
      .select()
      .from(emailMessage)
      .where(and(eq(emailMessage.id, emailId), eq(emailMessage.ownerId, principal.userId)))
      .limit(1);
    const email = rows[0];
    if (!email) throw new NotFoundException(`email ${emailId} not found`);

    // Context: what the user knows about this sender, and what's open with them.
    const retrieved = await this.retrieval.retrieve(
      principal,
      `What do I know about ${email.fromAddr}, and what is open or outstanding with them?`,
      { topK: CONTEXT_TOP_K },
    );
    const contextFacts = retrieved.memories
      .map((m) => m.memory.content)
      .filter(Boolean) as string[];

    const originalBody = isolateEmailContent(email.textBody);
    const { text } = await this.gateway.complete({
      system: REPLY_DRAFT_SYSTEM,
      input: buildDraftInput({
        from: email.fromAddr,
        subject: email.subject,
        body: originalBody,
        context: contextFacts,
      }),
      tier: 'answer',
    });

    const subject = replySubject(email.subject);
    const references = [...email.references, email.messageId].filter(
      (r): r is string => typeof r === 'string' && r.length > 0,
    );
    const payload: EmailReplyDraftPayload = {
      to: email.fromAddr,
      subject,
      inReplyTo: email.messageId ?? null,
      references,
      body: (text ?? '').trim() || '(no draft produced)',
      emailSourceId: email.id,
    };
    // The approval machine records + audits the draft; approval finalises it
    // (non-sending), then GET /api/approvals/:id/email-draft presents it.
    return this.approvals.create(principal, EMAIL_REPLY_DRAFT_ACTION, payload);
  }
}

function replySubject(subject: string | null): string {
  const base = (subject ?? '').trim();
  if (!base) return 'Re:';
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

function buildDraftInput(input: {
  from: string;
  subject: string | null;
  body: string;
  context: string[];
}): string {
  const context =
    input.context.length > 0
      ? input.context.map((f, i) => `- [${i + 1}] ${f}`).join('\n')
      : '(no relevant facts on record)';
  return [
    `ORIGINAL MESSAGE from ${input.from}`,
    `Subject: ${input.subject ?? '(none)'}`,
    '',
    input.body || '(empty body)',
    '',
    'CONTEXT FACTS (what the user knows about the sender / open loops):',
    context,
    '',
    'Draft the reply body now.',
  ].join('\n');
}
