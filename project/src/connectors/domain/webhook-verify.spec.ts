import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from './webhook-verify';

const secret = 'shhh-not-a-real-secret';
const body = Buffer.from(JSON.stringify({ eventId: 'evt_1', items: [] }), 'utf8');
const now = new Date('2026-08-11T12:00:00Z');

const plain = {
  signatureHeader: 'x-signature',
  algorithm: 'sha256' as const,
  encoding: 'hex' as const,
};

const stamped = {
  ...plain,
  signaturePrefix: 'sha256=',
  timestampHeader: 'x-timestamp',
  toleranceSeconds: 300,
};

function sign(payload: Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

describe('webhook_verify: refuse before parse, over the raw bytes', () => {
  it('a_valid_signature_passes', () => {
    const headers = { 'x-signature': sign(body) };
    expect(verifyWebhookSignature(plain, secret, body, headers, now)).toEqual({ ok: true });
  });

  it('a_missing_or_wrong_signature_refuses', () => {
    expect(verifyWebhookSignature(plain, secret, body, {}, now)).toEqual({
      ok: false,
      refusal: 'missing_signature',
    });
    const headers = { 'x-signature': sign(Buffer.from('other')) };
    expect(verifyWebhookSignature(plain, secret, body, headers, now)).toEqual({
      ok: false,
      refusal: 'bad_signature',
    });
  });

  it('a_single_flipped_byte_in_the_body_refuses', () => {
    const headers = { 'x-signature': sign(body) };
    const tampered = Buffer.from(body);
    tampered[0] = tampered[0]! ^ 0xff;
    expect(verifyWebhookSignature(plain, secret, tampered, headers, now)).toEqual({
      ok: false,
      refusal: 'bad_signature',
    });
  });

  it('timestamped_scheme_signs_timestamp_dot_body_and_bounds_replay', () => {
    const stamp = String(Math.floor(now.getTime() / 1000));
    const signed = sign(Buffer.concat([Buffer.from(`${stamp}.`), body]));
    const headers = { 'x-signature': `sha256=${signed}`, 'x-timestamp': stamp };
    expect(verifyWebhookSignature(stamped, secret, body, headers, now)).toEqual({ ok: true });

    // The same, replayed twenty minutes later: refused as stale.
    const later = new Date(now.getTime() + 20 * 60 * 1000);
    expect(verifyWebhookSignature(stamped, secret, body, headers, later)).toEqual({
      ok: false,
      refusal: 'stale_timestamp',
    });
  });

  it('a_timestamp_header_missing_when_the_scheme_requires_it_refuses', () => {
    const headers = { 'x-signature': `sha256=${sign(body)}` };
    expect(verifyWebhookSignature(stamped, secret, body, headers, now)).toEqual({
      ok: false,
      refusal: 'missing_timestamp',
    });
  });

  it('a_signature_without_the_declared_prefix_refuses', () => {
    const stamp = String(Math.floor(now.getTime() / 1000));
    const signed = sign(Buffer.concat([Buffer.from(`${stamp}.`), body]));
    const headers = { 'x-signature': signed, 'x-timestamp': stamp };
    expect(verifyWebhookSignature(stamped, secret, body, headers, now)).toEqual({
      ok: false,
      refusal: 'bad_signature',
    });
  });
});
