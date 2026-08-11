import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConnectorWebhookScheme } from '../connector-descriptor';

/**
 * Webhook signature verification (V2.5 item 8.1, issue D), pure and over the
 * RAW bytes: nothing is parsed until the signature holds. Ingress endpoints
 * are unauthenticated by nature and therefore hostile-facing; this function
 * is the gate everything else stands behind.
 *
 * The generic scheme covers the field's convergent shape: an HMAC over the
 * body (optionally prefixed with the timestamp header, `timestamp.body`, the
 * replay-protected variant), carried in a header, hex or base64, with or
 * without a literal prefix. A provider with a genuinely different scheme
 * extends this file rather than hand-rolling in its own module.
 */

export type WebhookRefusal =
  'missing_signature' | 'bad_signature' | 'missing_timestamp' | 'stale_timestamp';

export function verifyWebhookSignature(
  scheme: Pick<
    ConnectorWebhookScheme,
    | 'signatureHeader'
    | 'algorithm'
    | 'encoding'
    | 'signaturePrefix'
    | 'timestampHeader'
    | 'toleranceSeconds'
  >,
  secret: string,
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  now: Date,
): { ok: true } | { ok: false; refusal: WebhookRefusal } {
  const presented = headers[scheme.signatureHeader];
  if (!presented) return { ok: false, refusal: 'missing_signature' };

  let signedPayload: Buffer = rawBody;
  if (scheme.timestampHeader) {
    const stamp = headers[scheme.timestampHeader];
    if (!stamp) return { ok: false, refusal: 'missing_timestamp' };
    const parsed = parseTimestamp(stamp);
    if (parsed === null) return { ok: false, refusal: 'stale_timestamp' };
    const tolerance = (scheme.toleranceSeconds ?? 300) * 1000;
    if (Math.abs(now.getTime() - parsed) > tolerance) {
      return { ok: false, refusal: 'stale_timestamp' };
    }
    signedPayload = Buffer.concat([Buffer.from(`${stamp}.`, 'utf8'), rawBody]);
  }

  const expected = createHmac(scheme.algorithm, secret).update(signedPayload).digest();
  const stripped = scheme.signaturePrefix
    ? presented.startsWith(scheme.signaturePrefix)
      ? presented.slice(scheme.signaturePrefix.length)
      : null
    : presented;
  if (stripped === null) return { ok: false, refusal: 'bad_signature' };

  let presentedBytes: Buffer;
  try {
    presentedBytes = Buffer.from(stripped, scheme.encoding);
  } catch {
    return { ok: false, refusal: 'bad_signature' };
  }
  // Re-encode round-trip guards malformed hex/base64 quietly truncating.
  if (presentedBytes.length !== expected.length || !timingSafeEqual(presentedBytes, expected)) {
    return { ok: false, refusal: 'bad_signature' };
  }
  return { ok: true };
}

/** Seconds-since-epoch or ISO-8601; anything else refuses. */
function parseTimestamp(stamp: string): number | null {
  if (/^\d{9,13}$/.test(stamp)) {
    const n = Number(stamp);
    return stamp.length >= 13 ? n : n * 1000;
  }
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? null : parsed;
}
