import { describe, expect, it } from 'vitest';
import {
  domainOf,
  matchSender,
  normalizeAddress,
  normalizeAllowlistValue,
  sanitizeHtml,
  senderMatchesAllowlist,
} from './email-parse';

describe('email-parse (pure helpers, decision 0028)', () => {
  describe('normalizeAddress', () => {
    it('lower-cases and strips display name + angle brackets', () => {
      expect(normalizeAddress('Ana Kova <Ana@Adriatic-Foods.HR>')).toBe('ana@adriatic-foods.hr');
      expect(normalizeAddress('  bob@example.com ')).toBe('bob@example.com');
    });
    it('rejects malformed addresses', () => {
      expect(normalizeAddress('')).toBeNull();
      expect(normalizeAddress(null)).toBeNull();
      expect(normalizeAddress('no-at-sign')).toBeNull();
      expect(normalizeAddress('two@@ats.com')).toBeNull();
      expect(normalizeAddress('a b@c.com')).toBeNull();
      expect(normalizeAddress('trailing@')).toBeNull();
    });
  });

  it('domainOf returns the domain half', () => {
    expect(domainOf('ana@adriatic-foods.hr')).toBe('adriatic-foods.hr');
    expect(domainOf('nonsense')).toBeNull();
  });

  describe('normalizeAllowlistValue', () => {
    it('normalizes address entries like an address', () => {
      expect(normalizeAllowlistValue('address', 'Ana@Adriatic-Foods.HR')).toBe(
        'ana@adriatic-foods.hr',
      );
      expect(normalizeAllowlistValue('address', 'not-an-address')).toBeNull();
    });
    it('normalizes domain entries: strips @, lower-cases, requires a dot', () => {
      expect(normalizeAllowlistValue('domain', '@Adriatic-Foods.HR')).toBe('adriatic-foods.hr');
      expect(normalizeAllowlistValue('domain', 'adriatic-foods.hr')).toBe('adriatic-foods.hr');
      expect(normalizeAllowlistValue('domain', 'localhost')).toBeNull();
      expect(normalizeAllowlistValue('domain', 'a@b.com')).toBeNull();
    });
  });

  describe('matchSender', () => {
    it('prefers the verified envelope sender, falls back to header From', () => {
      expect(matchSender('envelope@x.com', 'header@y.com')).toBe('envelope@x.com');
      expect(matchSender(null, 'header@y.com')).toBe('header@y.com');
      expect(matchSender('', 'header@y.com')).toBe('header@y.com');
      expect(matchSender(null, null)).toBeNull();
    });
  });

  describe('senderMatchesAllowlist', () => {
    const entries = [
      { kind: 'address' as const, value: 'ana@adriatic-foods.hr' },
      { kind: 'domain' as const, value: 'trusted.example' },
    ];
    it('matches an exact address entry', () => {
      expect(senderMatchesAllowlist('ana@adriatic-foods.hr', entries)).toBe(true);
      expect(senderMatchesAllowlist('ANA@Adriatic-Foods.HR', entries)).toBe(true);
    });
    it('matches any address in a domain entry', () => {
      expect(senderMatchesAllowlist('anyone@trusted.example', entries)).toBe(true);
    });
    it('does not match subdomains implicitly', () => {
      expect(senderMatchesAllowlist('x@sub.trusted.example', entries)).toBe(false);
    });
    it('refuses unknown senders and empty allowlists (closed by default)', () => {
      expect(senderMatchesAllowlist('stranger@example.net', entries)).toBe(false);
      expect(senderMatchesAllowlist('ana@adriatic-foods.hr', [])).toBe(false);
      expect(senderMatchesAllowlist(null, entries)).toBe(false);
    });
  });

  describe('sanitizeHtml', () => {
    it('drops script/style/iframe and inline handlers and js: urls', () => {
      const dirty =
        '<p onclick="steal()">Hi</p><script>evil()</script>' +
        '<style>b{}</style><a href="javascript:alert(1)">x</a>' +
        '<iframe src="http://evil"></iframe>';
      const clean = sanitizeHtml(dirty) ?? '';
      expect(clean).toContain('<p');
      expect(clean).toContain('Hi');
      expect(clean.toLowerCase()).not.toContain('<script');
      expect(clean.toLowerCase()).not.toContain('<style');
      expect(clean.toLowerCase()).not.toContain('<iframe');
      expect(clean.toLowerCase()).not.toContain('onclick');
      expect(clean.toLowerCase()).not.toContain('javascript:');
    });
    it('returns null for empty input', () => {
      expect(sanitizeHtml(null)).toBeNull();
      expect(sanitizeHtml('')).toBeNull();
    });
  });

  // Quoted-history / signature / forwarded isolation moved to ingestion's
  // `isolateEmailContent` (email-preprocess.spec.ts) — it is an extraction
  // concern shared with the golden-set harness (Session O4 — email source).
});
