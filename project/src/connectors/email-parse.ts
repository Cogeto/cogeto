import type { EmailAllowlistKind } from '@cogeto/shared';

/**
 * Pure, deterministic email helpers (decision 0028) — no I/O, no parser: sender
 * normalization + allowlist matching, a conservative HTML sanitizer for the
 * retained/display HTML, and a quoted-history stripper used ONLY to build the
 * extraction input (the full bodies are always retained verbatim). Unit-tested
 * in isolation; the intake service composes them around mailparser.
 */

/** An allowlist entry as the matcher needs it (kind + normalized value). */
export interface AllowlistEntry {
  kind: EmailAllowlistKind;
  value: string;
}

/**
 * Normalize a raw address to `local@domain`, lower-cased, display name and
 * angle brackets stripped. Returns null when there is no plausible address
 * (so an empty envelope sender falls back to header From upstream).
 */
export function normalizeAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  // Prefer the last <...> group if present ("Ana Kova <ana@x.hr>" → ana@x.hr).
  const angled = value.match(/<([^>]+)>/);
  if (angled) value = angled[1]!.trim();
  value = value
    .replace(/^"+|"+$/g, '')
    .trim()
    .toLowerCase();
  // A bare, single, well-formed address only — reject anything with whitespace
  // or a missing/duplicated '@'.
  if (/\s/.test(value)) return null;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return null;
  return value;
}

/** The domain half of a normalized address, or null. */
export function domainOf(address: string | null | undefined): string | null {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;
  return normalized.slice(normalized.indexOf('@') + 1);
}

/**
 * Normalize an allowlist entry VALUE for storage/matching: addresses like an
 * address; domains bare (a leading '@' and surrounding space stripped),
 * lower-cased. Returns null when the value is not valid for its kind.
 */
export function normalizeAllowlistValue(kind: EmailAllowlistKind, raw: string): string | null {
  if (kind === 'address') return normalizeAddress(raw);
  const domain = raw.trim().replace(/^@+/, '').toLowerCase();
  // A plausible domain: at least one dot, no whitespace, no '@'.
  if (!domain || /\s|@/.test(domain) || !domain.includes('.')) return null;
  return domain;
}

/**
 * The acceptance decision (decision 0028 ruling 2): the message's matched sender
 * must be an `address` entry, or its domain must be a `domain` entry. An empty
 * allowlist matches nothing (closed by default). Subdomains are not implicitly
 * included — the exact domain must be listed.
 */
export function senderMatchesAllowlist(
  matchedSender: string | null,
  entries: readonly AllowlistEntry[],
): boolean {
  const sender = normalizeAddress(matchedSender);
  if (!sender) return false;
  const domain = sender.slice(sender.indexOf('@') + 1);
  for (const entry of entries) {
    if (entry.kind === 'address' && entry.value === sender) return true;
    if (entry.kind === 'domain' && entry.value === domain) return true;
  }
  return false;
}

/**
 * The sender used for allowlist matching (decision 0028 ruling 2a): the verified
 * envelope sender (SMTP MAIL FROM) when present, else the header From.
 */
export function matchSender(
  envelopeFrom: string | null | undefined,
  headerFrom: string | null | undefined,
): string | null {
  return normalizeAddress(envelopeFrom) ?? normalizeAddress(headerFrom);
}

/**
 * A conservative, dependency-free HTML sanitizer for the RETAINED/display HTML
 * (decision 0028 ruling 5): drops executable and remote-active constructs
 * (<script>/<style>/<iframe>/<object>/<embed>/<link>/<meta>), inline event
 * handlers (on*), and javascript:/vbscript: URLs. The HTML is stored for display
 * and future use, never rendered as active content in v1. This is defense in
 * depth for retention, not a full XSS sanitizer.
 */
export function sanitizeHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  let out = html;
  // Remove whole dangerous elements (open→close, non-greedy, case-insensitive).
  out = out.replace(/<\s*(script|style|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  // Remove void/dangerous singletons.
  out = out.replace(/<\s*(link|meta|base)\b[^>]*>/gi, '');
  // Strip inline event handlers: on…="…" / on…='…' / on…=value.
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  // Neutralize javascript:/vbscript: URLs in href/src.
  out = out.replace(/(href|src)\s*=\s*("|')?\s*(javascript|vbscript):[^"'\s>]*/gi, '$1=$2#');
  return out;
}

// Extraction-input isolation (quoted-history / signature / forwarded stripping)
// lives in ingestion as `isolateEmailContent` (Session O4 — email source): it is
// an extraction-preprocessing concern shared with the golden-set harness, not a
// retention concern. This module keeps only sender/allowlist normalization and
// the retention-side HTML sanitizer above.
