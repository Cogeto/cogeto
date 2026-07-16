import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { simpleParser } from 'mailparser';
import type { AddressObject, ParsedMail } from 'mailparser';
import { ALLOWED_UPLOAD_CONTENT_TYPES } from '@cogeto/shared';
import type { MemoryScope } from '@cogeto/shared';
import { DRIZZLE, withTransactionalEnqueue } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { INGESTION_PIPELINE_JOB_TYPE } from '../ingestion/index';
import { MemoryFileStore, MemoryObjectStore } from '../memory/index';
import { UserDirectory } from '../identity/index';
import { EmailAllowlistService } from './email-allowlist.service';
import { UserSettingsService } from './user-settings.service';
import { sniffContentType } from './document-extract';
import { summarizeCalendarInvites } from './email-calendar';
import { matchSender, normalizeAddress, sanitizeHtml } from './email-parse';
import { emailAttachment, emailMessage } from './persistence/tables';
import { MAIL_OPTIONS } from './mail-options';
import type { MailOptions } from './mail-options';

/** A permanent parse error still consumes retries, so attachment file jobs cap
 * attempts low (matches the file upload path). */
const FILE_PIPELINE_MAX_ATTEMPTS = 3;
/** HTML stored inline up to this size; larger bodies go to MinIO. */
const HTML_INLINE_MAX_BYTES = 256 * 1024;
const CLEANUP_ATTEMPTS = 3;
const CLEANUP_RETRY_DELAY_MS = 250;

/** The envelope the Haraka queue hook reports (SMTP MAIL FROM / RCPT TO). */
export interface MailEnvelope {
  mailFrom: string | null;
  rcptTo: string | null;
}

/** The intake verdict the internal endpoint maps to an SMTP response (ruling 7).
 * Sender-routed capture (decision 0031) can store a copy per matching user,
 * hence a list of stored email ids. */
export type IntakeResult =
  | { accepted: true; emailIds: string[] }
  | { accepted: false; status: 'refused' | 'too_large' | 'bad_recipient'; reason: string };

interface PreparedObject {
  key: string;
  body: Buffer;
  contentType: string;
}

/**
 * Inbound email intake (Session O4, decision 0028; routing revised by decision
 * 0031): parse the raw RFC822, resolve the RECIPIENT USERS from the sender —
 * a registered user's own address routes to that user; otherwise every user
 * whose personal allowlist matches the sender receives a copy; otherwise the
 * message is refused (closed by default; the bootstrap admin account never
 * captures). Each recipient's copy is fully retained (headers, both bodies,
 * all attachments, the raw original in MinIO) under their default capture
 * scope, supported document attachments become linked file sources, and the
 * email body is enqueued into the ingestion pipeline — all transactionally via
 * the outbox (the file-upload safe order, ruling 8).
 *
 * A refused message stores NOTHING but a metadata-only refusal row. Storage is
 * reached only through the memory module's object-store + file-metadata ports
 * (decision 0003 ruling 2); this service owns the email_* tables.
 */
@Injectable()
export class EmailIntakeService {
  private readonly logger = new Logger(EmailIntakeService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly objects: MemoryObjectStore,
    private readonly files: MemoryFileStore,
    private readonly allowlist: EmailAllowlistService,
    private readonly directory: UserDirectory,
    private readonly settings: UserSettingsService,
    @Inject(MAIL_OPTIONS) private readonly options: MailOptions,
  ) {}

  async intake(raw: Buffer, envelope: MailEnvelope): Promise<IntakeResult> {
    // (0) Size cap — cheap, before parsing (Haraka also caps; app is authoritative).
    if (raw.length > this.options.maxBytes) {
      await this.refuse(envelope, null, 'message_too_large');
      return { accepted: false, status: 'too_large', reason: 'message exceeds the size cap' };
    }

    const parsed = await simpleParser(raw);
    const headerFrom = firstAddress(parsed.from);
    const matchedSender = matchSender(envelope.mailFrom, headerFrom);

    // (1) Recipient validation — only the instance's configured address.
    const rcpt = normalizeAddress(envelope.rcptTo) ?? firstAddress(parsed.to);
    if (!this.recipientAccepted(rcpt)) {
      await this.refuse(envelope, matchedSender, 'wrong_recipient');
      return { accepted: false, status: 'bad_recipient', reason: 'recipient not accepted here' };
    }

    // (2) Sender-routed recipients (decision 0031) — refuse rather than guess.
    const recipients = await this.resolveRecipients(matchedSender);
    if (recipients.length === 0) {
      await this.refuse(envelope, matchedSender, 'sender_not_recognized');
      return {
        accepted: false,
        status: 'refused',
        reason: 'sender is not a registered user and not on any allowlist',
      };
    }

    // (3) Attachment-size cap (ruling 6) — once, before any copy is stored.
    const attachments = parsed.attachments ?? [];
    const totalAttachmentBytes = attachments.reduce(
      (sum, a) => sum + (a.size ?? a.content.length),
      0,
    );
    if (totalAttachmentBytes > this.options.attachmentsMaxBytes) {
      await this.refuse(envelope, matchedSender, 'attachments_too_large');
      return { accepted: false, status: 'too_large', reason: 'attachments exceed the size cap' };
    }

    // (4) One retained copy per recipient, each under that user's default
    //     capture scope. A mid-loop failure aborts with copies already stored:
    //     Haraka receives a transient 451 and retries — thread-aware dedup and
    //     idempotent pipeline jobs absorb the re-delivery.
    const emailIds: string[] = [];
    for (const recipient of recipients) {
      const scope = await this.settings.defaultScopeFor(recipient.userId);
      const result = await this.store(
        raw,
        parsed,
        recipient,
        scope,
        matchedSender ?? headerFrom ?? '',
        rcpt ?? '',
      );
      emailIds.push(result);
    }
    return { accepted: true, emailIds };
  }

  /**
   * Decision 0031 routing: (1) a sender that IS a registered user routes to
   * that user (their own address is implicitly trusted); (2) otherwise every
   * user whose allowlist matches the sender gets a copy; (3) nobody → empty
   * (refused upstream). The bootstrap admin account is excluded — the operator
   * login never captures memory.
   */
  private async resolveRecipients(
    matchedSender: string | null,
  ): Promise<Array<{ userId: string; orgId: string }>> {
    if (!matchedSender) return [];
    const adminEmail = normalizeAddress(this.options.adminUserEmail);
    if (adminEmail && matchedSender === adminEmail) return [];

    const self = await this.directory.userByEmail(matchedSender);
    if (self) return [{ userId: self.userId, orgId: self.orgId }];

    const ownerIds = await this.allowlist.ownersMatching(matchedSender);
    const users = await this.directory.usersByIds(ownerIds);
    return users
      .filter((u) => !adminEmail || (u.email ?? '').toLowerCase() !== adminEmail)
      .map((u) => ({ userId: u.userId, orgId: u.orgId }));
  }

  /** Store one recipient's copy + enqueue in the safe order (object-first,
   * then one transaction). Returns the stored email id. */
  private async store(
    raw: Buffer,
    parsed: ParsedMail,
    owner: { userId: string; orgId: string },
    scope: MemoryScope,
    fromAddr: string,
    toAddr: string,
  ): Promise<string> {
    const sensitive = false;
    const emailId = randomUUID();
    const keyBase = `${owner.orgId}/${owner.userId}/${scope}`;

    const rawKey = `${keyBase}/email-${emailId}`;
    const htmlSanitized = sanitizeHtml(typeof parsed.html === 'string' ? parsed.html : null);
    const htmlBytes = htmlSanitized ? Buffer.byteLength(htmlSanitized, 'utf8') : 0;
    const htmlToObject = htmlSanitized !== null && htmlBytes > HTML_INLINE_MAX_BYTES;
    const htmlKey = htmlToObject ? `${keyBase}/email-${emailId}.html` : null;

    // Supported document attachments become their own stored file sources.
    const attachmentPlans = (parsed.attachments ?? []).map((a) => {
      const declared = (a.contentType ?? '').split(';')[0]!.trim().toLowerCase();
      const sniffed = sniffContentType(a.content);
      const resolved = ALLOWED_UPLOAD_CONTENT_TYPES.includes(declared)
        ? declared
        : sniffed && ALLOWED_UPLOAD_CONTENT_TYPES.includes(sniffed)
          ? sniffed
          : null;
      const supported = resolved !== null;
      return {
        filename: a.filename ?? null,
        declaredType: declared || null,
        size: a.size ?? a.content.length,
        content: a.content,
        supported,
        resolvedType: resolved,
        fileKey: supported ? `${keyBase}/file-${randomUUID()}` : null,
      };
    });

    // (1) object-first: raw original, sanitised HTML (if externalised), and each
    //     supported attachment's bytes. Track everything written for cleanup.
    const written: PreparedObject[] = [{ key: rawKey, body: raw, contentType: 'message/rfc822' }];
    if (htmlKey && htmlSanitized) {
      written.push({
        key: htmlKey,
        body: Buffer.from(htmlSanitized, 'utf8'),
        contentType: 'text/html',
      });
    }
    for (const plan of attachmentPlans) {
      if (plan.supported && plan.fileKey && plan.resolvedType) {
        written.push({ key: plan.fileKey, body: plan.content, contentType: plan.resolvedType });
      }
    }
    for (const obj of written) {
      await this.objects.putObject(obj.key, obj.body, {
        contentType: obj.contentType,
        metadata: { 'owner-id': owner.userId, scope, sensitive: String(sensitive) },
      });
    }

    try {
      // (2) one transaction: the email row, attachment rows, attachment
      //     file_metadata, and all pipeline enqueues via the outbox.
      await this.db.transaction(async (tx) => {
        await tx.insert(emailMessage).values({
          id: emailId,
          ownerId: owner.userId,
          scope,
          sensitive,
          messageId: parsed.messageId ?? null,
          inReplyTo: parsed.inReplyTo ?? null,
          references: normalizeReferences(parsed.references),
          fromAddr,
          toAddr,
          subject: parsed.subject ?? null,
          sentAt: parsed.date ?? null,
          rawObjectKey: rawKey,
          textBody: parsed.text ?? null,
          htmlBody: htmlToObject ? null : htmlSanitized,
          htmlObjectKey: htmlKey,
          // Deterministic summary of any calendar-invite (VEVENT) parts (GAP-4).
          calendarSummary: summarizeCalendarInvites(parsed.attachments ?? []),
          headersJson: headerMap(parsed),
          hasAttachments: attachmentPlans.length > 0,
        });

        for (const plan of attachmentPlans) {
          await tx.insert(emailAttachment).values({
            emailId,
            filename: plan.filename,
            contentType: plan.declaredType,
            sizeBytes: plan.size,
            fileObjectKey: plan.fileKey,
            processed: plan.supported,
          });
          if (plan.supported && plan.fileKey) {
            // A stored file source, exactly like an upload: file_metadata row +
            // its own pipeline job (source_type 'file'). FileSourceReader reads it.
            await this.files.record(tx, {
              objectKey: plan.fileKey,
              ownerId: owner.userId,
              scope,
              sensitive,
              checksum: createHash('sha256').update(plan.content).digest('hex'),
              sizeBytes: plan.size,
            });
            await withTransactionalEnqueue(
              tx,
              {
                type: 'email.attachment.stored',
                payload: {
                  source_type: 'file',
                  source_id: plan.fileKey,
                  owner_id: owner.userId,
                  email_id: emailId,
                },
              },
              {
                type: INGESTION_PIPELINE_JOB_TYPE,
                payload: { source_type: 'file', source_id: plan.fileKey },
                maxAttempts: FILE_PIPELINE_MAX_ATTEMPTS,
              },
            );
          }
        }

        // The email body itself → the ingestion pipeline (source_type 'email').
        await withTransactionalEnqueue(
          tx,
          {
            type: 'email.received',
            payload: { source_type: 'email', source_id: emailId, owner_id: owner.userId },
          },
          {
            type: INGESTION_PIPELINE_JOB_TYPE,
            payload: { source_type: 'email', source_id: emailId },
          },
        );
      });
    } catch (error) {
      // (3) abort-window cleanup: the transaction left no rows/jobs, so every
      //     object written above is an orphan — remove them (logged + retried;
      //     the nightly sweep's orphan arm is the backstop).
      for (const obj of written) await this.cleanupOrphanObject(obj.key);
      throw error;
    }

    return emailId;
  }

  private recipientAccepted(rcpt: string | null): boolean {
    const configured = this.options.inboundAddress;
    // Unconfigured instance rejects all recipients (closed by default, ruling 1).
    if (!configured) return false;
    return rcpt !== null && rcpt === normalizeAddress(configured);
  }

  private async refuse(
    envelope: MailEnvelope,
    matchedSender: string | null,
    reason: string,
  ): Promise<void> {
    // Metadata only — never a body (ruling 7). Refusals carry no owner under
    // sender routing (nobody matched — decision 0031); a null owner makes the
    // refusal visible to every user's "Recently refused" so any of them can
    // claim the sender. Best-effort; a logging failure must not turn a clean
    // refusal into a 500.
    try {
      await this.allowlist.recordRefusal(this.db, {
        ownerId: null,
        fromAddr: matchedSender ?? normalizeAddress(envelope.mailFrom),
        toAddr: normalizeAddress(envelope.rcptTo),
        reason,
      });
    } catch (error) {
      this.logger.warn(`failed to record email refusal (${reason}): ${message(error)}`);
    }
  }

  private async cleanupOrphanObject(objectKey: string): Promise<void> {
    for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await this.objects.deleteObject(objectKey);
        return;
      } catch {
        if (attempt === CLEANUP_ATTEMPTS) {
          this.logger.error(
            `abort-window cleanup failed after ${attempt} attempts; ` +
              `orphan object left for the integrity sweep: ${objectKey}`,
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, CLEANUP_RETRY_DELAY_MS * attempt));
      }
    }
  }
}

/** The first address string from a mailparser AddressObject (or undefined). */
function firstAddress(addr: AddressObject | AddressObject[] | undefined): string | null {
  if (!addr) return null;
  const one = Array.isArray(addr) ? addr[0] : addr;
  return one?.value?.[0]?.address ?? null;
}

/** mailparser references may be a string, array, or undefined → string[]. */
function normalizeReferences(refs: string | string[] | undefined): string[] {
  if (!refs) return [];
  return Array.isArray(refs) ? refs : [refs];
}

/** The full header set as a flat object (structural retention, ruling 5). */
function headerMap(parsed: ParsedMail): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, line } of parsed.headerLines) {
    // headerLines preserves order + duplicates; join duplicates with a newline.
    out[key] = out[key] ? `${out[key]}\n${line}` : line;
  }
  return out;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
