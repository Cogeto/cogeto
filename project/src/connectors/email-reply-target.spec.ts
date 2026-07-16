import { describe, expect, it } from 'vitest';
import { resolveReplyTarget } from './email-reply-target';
import type { ReplyTargetSource } from './email-reply-target';

const OWNER = 'me@company.example';

function email(over: Partial<ReplyTargetSource>): ReplyTargetSource {
  return {
    fromAddr: 'ana@adriatic-foods.hr',
    subject: 'Proposal',
    messageId: '<orig@x>',
    references: [],
    textBody: 'Hi, here is the proposal.',
    ...over,
  };
}

describe('resolveReplyTarget — forwarded-addressing recovery (Session O4)', () => {
  it('forwarded_reply_addressing: a directly-received email replies to its actual From', () => {
    const t = resolveReplyTarget(email({ fromAddr: 'Ana <ana@adriatic-foods.hr>' }), OWNER);
    expect(t.to).toBe('ana@adriatic-foods.hr');
    expect(t.resolved).toBe(true);
    expect(t.recipientVerified).toBe(true); // the message's own From is trusted
    expect(t.isForward).toBe(false);
    expect(t.subject).toBe('Re: Proposal');
  });

  it('forwarded_reply_addressing: a manual forward replies to the RECOVERED original correspondent, not the forwarder', () => {
    const body = [
      'FYI — see below.',
      '',
      '---------- Forwarded message ---------',
      'From: Ana Kovač <ana@adriatic-foods.hr>',
      'Date: Tue, 7 Jul 2026',
      'Subject: Delivery schedule',
      'To: me@company.example',
      '',
      'We will deliver on Friday.',
    ].join('\n');
    // The forwarder (the capture user) is the envelope/header From.
    const t = resolveReplyTarget(
      email({ fromAddr: OWNER, subject: 'Fwd: Delivery schedule', textBody: body }),
      OWNER,
    );
    expect(t.to).toBe('ana@adriatic-foods.hr'); // Ana, NOT the forwarder
    expect(t.resolved).toBe(true);
    // Recovered from the forwarded BODY — a suggestion to verify, not trusted (SEC-3).
    expect(t.recipientVerified).toBe(false);
    expect(t.isForward).toBe(true);
    expect(t.originalCorrespondent).toContain('ana@adriatic-foods.hr');
    expect(t.subject).toBe('Re: Delivery schedule'); // threads on the original subject
    expect(t.inReplyTo).toBeNull();
  });

  it('forwarded_reply_addressing: a forward whose original sender cannot be recovered leaves the recipient UNSET', () => {
    // A self-forward (envelope From is the capture user) with no parseable
    // forwarded header block.
    const t = resolveReplyTarget(
      email({
        fromAddr: OWNER,
        subject: 'Fwd: something',
        textBody: 'just some pasted text, no headers',
      }),
      OWNER,
    );
    expect(t.to).toBe('');
    expect(t.resolved).toBe(false);
    expect(t.isForward).toBe(true);
  });

  it('provider auto-forward / BCC that preserved the original From addresses correctly (no body parsing needed)', () => {
    // The message's own From is already the original sender (Ana), owner differs.
    const t = resolveReplyTarget(
      email({ fromAddr: 'ana@adriatic-foods.hr', textBody: 'auto-forwarded body' }),
      OWNER,
    );
    expect(t.to).toBe('ana@adriatic-foods.hr');
    expect(t.resolved).toBe(true);
  });

  it('normalizes Re: — no doubled prefix', () => {
    expect(resolveReplyTarget(email({ subject: 'Re: Proposal' }), OWNER).subject).toBe(
      'Re: Proposal',
    );
    expect(resolveReplyTarget(email({ subject: 'Fwd: Proposal' }), OWNER).subject).toBe(
      'Re: Proposal',
    );
  });
});
