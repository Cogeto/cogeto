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
import { sniffContentType } from './document-extract';
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

/** The intake verdict the internal endpoint maps to an SMTP response (ruling 7). */
export type IntakeResult =
  | { accepted: true; emailId: string }
  | { accepted: false; status: 'refused' | 'too_large' | 'bad_recipient'; reason: string };

interface PreparedObject {
  key: string;
  body: Buffer;
  contentType: string;
}

/**
 * Inbound email intake (Session O4, decision 0028): parse the raw RFC822, gate
 * on the sender allowlist (the primary acceptance control), retain the complete
 * message (headers, both bodies, all attachments, the raw original in MinIO),
 * route supported document attachments into the document pipeline as linked file
 * sources, and enqueue the email body into the ingestion pipeline — all
 * transactionally via the outbox (the file-upload safe order, ruling 8).
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
    @Inject(MAIL_OPTIONS) private readonly options: MailOptions,
  ) {}

  async intake(raw: Buffer, envelope: MailEnvelope): Promise<IntakeResult> {
    // (0) Size cap — cheap, before parsing (Haraka also caps; app is authoritative).
    if (raw.length > this.options.maxBytes) {
      await this.refuse(null, envelope, null, 'message_too_large');
      return { accepted: false, status: 'too_large', reason: 'message exceeds the size cap' };
    }

    const parsed = await simpleParser(raw);
    const headerFrom = firstAddress(parsed.from);
    const matchedSender = matchSender(envelope.mailFrom, headerFrom);

    // (1) Recipient validation — only the instance's configured address.
    const rcpt = normalizeAddress(envelope.rcptTo) ?? firstAddress(parsed.to);
    if (!this.recipientAccepted(rcpt)) {
      await this.refuse(null, envelope, matchedSender, 'wrong_recipient');
      return { accepted: false, status: 'bad_recipient', reason: 'recipient not accepted here' };
    }

    // (2) Owner resolution (ruling 3) — refuse rather than guess.
    const owner = await this.directory.resolveCaptureOwner(this.options.captureUserEmail);
    if (!owner) {
      await this.refuse(null, envelope, matchedSender, 'no_owner');
      return { accepted: false, status: 'refused', reason: 'no capture owner configured' };
    }

    // (3) The allowlist gate (ruling 2) — closed by default.
    if (!(await this.allowlist.matches(owner.userId, matchedSender))) {
      await this.refuse(owner.userId, envelope, matchedSender, 'sender_not_allowlisted');
      return { accepted: false, status: 'refused', reason: 'sender not on the allowlist' };
    }

    // (4) Attachment-size cap (ruling 6).
    const attachments = parsed.attachments ?? [];
    const totalAttachmentBytes = attachments.reduce(
      (sum, a) => sum + (a.size ?? a.content.length),
      0,
    );
    if (totalAttachmentBytes > this.options.attachmentsMaxBytes) {
      await this.refuse(owner.userId, envelope, matchedSender, 'attachments_too_large');
      return { accepted: false, status: 'too_large', reason: 'attachments exceed the size cap' };
    }

    return this.store(raw, parsed, owner, matchedSender ?? headerFrom ?? '', rcpt ?? '');
  }

  /** Store + enqueue in the safe order (object-first, then one transaction). */
  private async store(
    raw: Buffer,
    parsed: ParsedMail,
    owner: { userId: string; orgId: string },
    fromAddr: string,
    toAddr: string,
  ): Promise<IntakeResult> {
    const scope: MemoryScope = 'private';
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

    return { accepted: true, emailId };
  }

  private recipientAccepted(rcpt: string | null): boolean {
    const configured = this.options.inboundAddress;
    // Unconfigured instance rejects all recipients (closed by default, ruling 1).
    if (!configured) return false;
    return rcpt !== null && rcpt === normalizeAddress(configured);
  }

  private async refuse(
    ownerId: string | null,
    envelope: MailEnvelope,
    matchedSender: string | null,
    reason: string,
  ): Promise<void> {
    // Metadata only — never a body (ruling 7). Best-effort; a logging failure
    // must not turn a clean refusal into a 500.
    try {
      await this.allowlist.recordRefusal(this.db, {
        ownerId,
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
