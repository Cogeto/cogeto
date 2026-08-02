import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import type { EmailAllowlistKind } from '@cogeto/shared';

/**
 * Pure, deterministic email helpers — no I/O, no parser: sender
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
 * The acceptance decision: the message's matched sender
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
 * The sender used for allowlist matching (ruling 2a): the verified
 * envelope sender (SMTP MAIL FROM) when present, else the header From.
 */
export function matchSender(
  envelopeFrom: string | null | undefined,
  headerFrom: string | null | undefined,
): string | null {
  return normalizeAddress(envelopeFrom) ?? normalizeAddress(headerFrom);
}

/**
 * Parser-based allowlist sanitizer for RETAINED/display HTML (security audit
 * 2.0 SEC-7).
 *
 * This used to be five regexes over the raw markup, and the audit demonstrated
 * two working bypasses against them:
 *
 *   `<img/src=x/onerror=alert(1)>`  — the handler strip required WHITESPACE
 *      before `on`, but HTML's before-attribute-name state accepts `/` as a
 *      separator just as happily.
 *   `href="javas&#99;ript:alert(1)"` — the scheme neutralizer matched the
 *      literal text, and the browser decodes the entity afterwards.
 *
 * Both are the same class of mistake: a regex reasons about the bytes, and the
 * browser reasons about the parse tree. So the regex path is REMOVED, not
 * patched. The markup is now parsed with the same tree construction a browser
 * uses (jsdom/parse5) and rebuilt from an allowlist by DOMPurify, which decides
 * on the parsed node — an attribute named `onerror` is dropped because it IS an
 * `onerror` attribute, however it was written, and an `href` is dropped because
 * its DECODED scheme is not allowed.
 *
 * The allowlist is what an email body legitimately needs: block and inline
 * formatting, lists, tables, links and images. Everything that executes,
 * navigates or embeds (`script`, `style`, `iframe`, `object`, `embed`, `link`,
 * `meta`, `base`, `form`) is absent by construction rather than removed by a
 * rule, which is the property regexes could not give us.
 *
 * This is one of two layers, not the only one: the SPA additionally renders the
 * result inside a sandboxed iframe with no script execution and no same-origin
 * access, so a future bypass of this layer has nowhere to run.
 */
const ALLOWED_TAGS = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];

const ALLOWED_ATTR = [
  'align',
  'alt',
  'border',
  'cellpadding',
  'cellspacing',
  'cite',
  'colspan',
  'dir',
  'height',
  'href',
  'lang',
  'rowspan',
  'span',
  'src',
  'style',
  'title',
  'valign',
  'width',
];

/**
 * DOMPurify needs a DOM. One jsdom window is created lazily and reused for the
 * process: constructing one per message would dominate intake cost, and the
 * window is only ever used as a parsing substrate — nothing from a message is
 * evaluated in it (jsdom runs no scripts unless explicitly configured to, and
 * this window never is).
 */
let purifier: ReturnType<typeof createDOMPurify> | null = null;

function sanitizer(): ReturnType<typeof createDOMPurify> {
  if (!purifier) {
    const { window } = new JSDOM('');
    purifier = createDOMPurify(window as unknown as Window & typeof globalThis);
    // Belt and braces on the two demonstrated bypass classes: strip every
    // remaining `on*` attribute whatever the allowlist says, and re-check the
    // DECODED value of every URL attribute. DOMPurify already does both; this
    // hook makes the property local and testable rather than inherited.
    purifier.addHook('uponSanitizeAttribute', (_node, data) => {
      const name = data.attrName.toLowerCase();
      if (name.startsWith('on')) {
        data.keepAttr = false;
        return;
      }
      if ((name === 'href' || name === 'src') && hasUnsafeScheme(data.attrValue)) {
        data.keepAttr = false;
        return;
      }
      // Inline `style` stays — an email body's whole layout lives there — but
      // the legacy script-in-CSS carriers do not. `expression()` and
      // `-moz-binding` are dead in current browsers and a `javascript:` inside
      // `url()` is refused by them, so this is defence in depth rather than the
      // only thing standing between a message and execution.
      if (name === 'style' && UNSAFE_CSS.test(data.attrValue)) {
        data.keepAttr = false;
      }
    });
  }
  return purifier;
}

/** The schemes a mail body may never link to or load from. */
const UNSAFE_SCHEMES = /^(javascript|vbscript|data|file|blob):/i;

/** Script-bearing CSS constructs; the whole `style` attribute is dropped. */
const UNSAFE_CSS = /(javascript|vbscript)\s*:|expression\s*\(|-moz-binding|behaviou?r\s*:/i;

/**
 * True when the value's scheme is unsafe once decoded. DOMPurify hands us the
 * value AFTER entity decoding, so `javas&#99;ript:` arrives here as
 * `javascript:` — which is exactly what the old regex could not see. Leading
 * whitespace and control characters are stripped first, because the URL parser
 * ignores them too.
 */
function hasUnsafeScheme(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return UNSAFE_SCHEMES.test(value.replace(/[\u0000-\u0020]/g, ''));
}

export function sanitizeHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const clean = sanitizer().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Keep the fragment's own markup only: no <html>/<body> wrapper is added,
    // which keeps the stored value a drop-in replacement for the old output.
    WHOLE_DOCUMENT: false,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    // Refuse the legacy IE constructs outright rather than sanitizing them.
    SAFE_FOR_TEMPLATES: false,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // Deliberately NO `USE_PROFILES`: a profile is a UNION with ALLOWED_TAGS,
    // so `{ html: true }` silently put `<style>` and `<form>` back. The
    // explicit list above is the whole allowlist, which also means `<svg>` and
    // `<math>` (foreign content, whose parsing rules differ from HTML's and
    // which are the classic mutation-XSS carrier) can never re-enter.
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'],
    FORBID_ATTR: ['srcdoc', 'formaction', 'xlink:href'],
  });
  return clean;
}

// Extraction-input isolation (quoted-history / signature / forwarded stripping)
// lives in ingestion as `isolateEmailContent`: it is
// an extraction-preprocessing concern shared with the golden-set harness, not a
// retention concern. This module keeps only sender/allowlist normalization and
// the retention-side HTML sanitizer above.
