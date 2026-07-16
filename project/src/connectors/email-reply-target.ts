import { parseForwardedHeaders } from '../ingestion/index';
import { normalizeAddress } from './email-parse';

/**
 * The recovered reply target for an email (Session O4 — the forwarded-addressing
 * rule). A reply must go to the ORIGINAL correspondent, never the forwarder:
 * when the user forwards Ana's mail to Cogeto, the message's own From is the
 * user and Ana is inside the forwarded body.
 */
export interface ReplyTarget {
  /** The recipient address to reply to; '' when it could not be recovered. */
  to: string;
  /** The recipient as shown (display name + address), for the UI/prompt. */
  toDisplay: string | null;
  subject: string;
  inReplyTo: string | null;
  references: string[];
  /** False when the original correspondent could not be recovered (a forward
   * with no parseable original) — the draft leaves the recipient unset. */
  resolved: boolean;
  /** Whether the recipient is TRUSTED. True only when it is the message's own
   * From (the address the server actually received). False when recovered by
   * parsing the forwarded body — attacker-controllable content the user must
   * verify before sending (SEC-3). Also false when unresolved. */
  recipientVerified: boolean;
  /** Whether the message arrived as a forward (envelope self-send and/or a
   * forwarded block in the body). */
  isForward: boolean;
  /** The recovered original sender as shown ("Ana Kovač <ana@…>"), for the
   * reading view's "Originally from:" label; null when none was recovered. */
  originalCorrespondent: string | null;
}

/** The email fields the resolver reads (a projection of email_message). */
export interface ReplyTargetSource {
  fromAddr: string;
  subject: string | null;
  messageId: string | null;
  references: string[];
  textBody: string | null;
}

/**
 * Recover who a reply should be addressed to. Precedence (documented so both
 * triggers behave identically):
 *
 *  1. The **recovered forwarded original From** — a forwarded block in the body
 *     names the real correspondent (the manual-forward case). Reply to them,
 *     thread on the original subject + Message-ID.
 *  2. Else the message's **own From**, when it is a plausible external
 *     correspondent (not the capture user's own address). This covers directly
 *     received mail AND provider-side auto-forward / BCC, which preserve the
 *     original sender on the message itself — so those address correctly with no
 *     body parsing.
 *  3. Else (a self-forward whose original could not be recovered) → recipient
 *     **unset**: the draft is still created, but the user must fill in the
 *     recipient rather than have Cogeto guess (or reply to themselves).
 */
export function resolveReplyTarget(
  email: ReplyTargetSource,
  ownerEmail: string | null,
): ReplyTarget {
  const forwarded = parseForwardedHeaders(email.textBody);
  const ownerAddr = normalizeAddress(ownerEmail);
  const messageFrom = normalizeAddress(email.fromAddr);
  const isSelfForward = ownerAddr !== null && messageFrom === ownerAddr;
  const isForward = forwarded !== null || isSelfForward;
  const originalCorrespondent = forwarded?.from ?? null;

  // 1. Recovered forwarded original correspondent. The address comes from the
  //    forwarded BODY (attacker-controllable), so it is resolved-but-UNVERIFIED
  //    (SEC-3): shown as a suggestion the user must confirm before sending.
  const recovered = normalizeAddress(forwarded?.from);
  if (recovered) {
    return {
      to: recovered,
      toDisplay: forwarded!.from,
      subject: replySubject(forwarded?.subject ?? email.subject),
      inReplyTo: forwarded?.messageId ?? null,
      references: dedupe([forwarded?.messageId]),
      resolved: true,
      recipientVerified: false,
      isForward: true,
      originalCorrespondent,
    };
  }

  // 2. The message's own external sender (direct mail, auto-forward, BCC) — the
  //    address the server actually received, so it is VERIFIED.
  if (messageFrom && !isSelfForward) {
    return {
      to: messageFrom,
      toDisplay: email.fromAddr,
      subject: replySubject(email.subject),
      inReplyTo: email.messageId ?? null,
      references: dedupe([...email.references, email.messageId]),
      resolved: true,
      recipientVerified: true,
      isForward,
      originalCorrespondent,
    };
  }

  // 3. Self-forward with no recoverable original — leave the recipient unset.
  return {
    to: '',
    toDisplay: null,
    subject: replySubject(forwarded?.subject ?? email.subject),
    inReplyTo: null,
    references: [],
    resolved: false,
    recipientVerified: false,
    isForward: true,
    originalCorrespondent,
  };
}

export function replySubject(subject: string | null | undefined): string {
  const base = (subject ?? '').trim().replace(/^(re|fwd|fw):\s*/i, '');
  return base ? `Re: ${base}` : 'Re:';
}

function dedupe(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}
