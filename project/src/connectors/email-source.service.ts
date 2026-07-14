import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type {
  EmailAttachmentDto,
  EmailReplyCandidateDto,
  EmailSourceDto,
  Principal,
} from '@cogeto/shared';
import { ALLOWED_UPLOAD_CONTENT_TYPES } from '@cogeto/shared';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { MemoryObjectStore } from '../memory/index';
import { emailAttachment, emailMessage } from './persistence/tables';
import { resolveReplyTarget } from './email-reply-target';

/** How many candidate emails the chat resolver considers for a name/sender. */
const CANDIDATE_LIMIT = 5;

/**
 * The email reading view + candidate resolution (Session O4 — email reply
 * triggers). Renders the full retained message faithfully for the source drawer,
 * and resolves which recent email a chat "draft a reply" request refers to.
 * Owner-scoped; reads only connectors' own tables + the memory object store
 * (for the externalised HTML body).
 */
@Injectable()
export class EmailSourceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly objects: MemoryObjectStore,
  ) {}

  /** The reading view behind an email memory's source drawer (owner-only). */
  async getSourceForOwner(principal: Principal, emailId: string): Promise<EmailSourceDto | null> {
    const rows = await this.db
      .select()
      .from(emailMessage)
      .where(and(eq(emailMessage.id, emailId), eq(emailMessage.ownerId, principal.userId)))
      .limit(1);
    const email = rows[0];
    if (!email) return null;

    // Prefer the retained sanitised HTML; externalised bodies live in MinIO.
    let htmlBody = email.htmlBody;
    if (!htmlBody && email.htmlObjectKey) {
      try {
        const object = await this.objects.getObject(email.htmlObjectKey);
        htmlBody = object.body.toString('utf8');
      } catch {
        htmlBody = null; // fall back to the text body
      }
    }

    const attachmentRows = await this.db
      .select()
      .from(emailAttachment)
      .where(eq(emailAttachment.emailId, emailId))
      .orderBy(asc(emailAttachment.createdAt));
    const attachments: EmailAttachmentDto[] = attachmentRows.map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      downloadable:
        a.fileObjectKey !== null &&
        a.contentType !== null &&
        ALLOWED_UPLOAD_CONTENT_TYPES.includes(a.contentType.split(';')[0]!.trim().toLowerCase()),
      fileObjectKey: a.fileObjectKey,
    }));

    const target = resolveReplyTarget(email, principal.email);

    return {
      id: email.id,
      from: email.fromAddr,
      to: email.toAddr,
      subject: email.subject,
      sentAt: email.sentAt?.toISOString() ?? null,
      receivedAt: email.receivedAt.toISOString(),
      textBody: email.textBody,
      htmlBody,
      hasAttachments: email.hasAttachments,
      attachments,
      scope: email.scope,
      sensitive: email.sensitive,
      isForward: target.isForward,
      originalCorrespondent: target.originalCorrespondent,
      replyRecipientResolved: target.resolved,
    };
  }

  /**
   * Recent emails matching a named person/sender for the chat reply resolver.
   * Matching is deliberately forgiving (sender address or subject contains the
   * name); most recent first. A null/blank name returns the most recent emails
   * (the "reply to that message" case). Only the owner's own emails.
   */
  async findReplyCandidates(
    principal: Principal,
    name: string | null,
  ): Promise<EmailReplyCandidateDto[]> {
    const trimmed = name?.trim() ?? '';
    const base = this.db
      .select({
        emailId: emailMessage.id,
        from: emailMessage.fromAddr,
        subject: emailMessage.subject,
        receivedAt: emailMessage.receivedAt,
      })
      .from(emailMessage)
      .where(
        trimmed
          ? and(
              eq(emailMessage.ownerId, principal.userId),
              or(
                ilike(emailMessage.fromAddr, `%${trimmed}%`),
                ilike(emailMessage.subject, `%${trimmed}%`),
                // The recovered forwarded original often names the person only in
                // the body — match there too.
                sql`${emailMessage.textBody} ILIKE ${'%' + trimmed + '%'}`,
              ),
            )
          : eq(emailMessage.ownerId, principal.userId),
      )
      .orderBy(desc(emailMessage.receivedAt))
      .limit(CANDIDATE_LIMIT);

    const rows = await base;
    return rows.map((r) => ({
      emailId: r.emailId,
      from: r.from,
      subject: r.subject,
      receivedAt: r.receivedAt.toISOString(),
    }));
  }
}
