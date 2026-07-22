/**
 * HTML → readable main content (Priority 5 Part A; decision 0042). A
 * deterministic, dependency-free boilerplate stripper in the same spirit as the
 * email preprocessing (`isolateEmailContent`): parse-and-strip, NEVER render —
 * no DOM, no script execution, no resource loading, so an untrusted page can
 * only ever contribute text.
 *
 * Heuristics (readability-style, not a full readability port):
 * 1. Drop non-content subtrees wholesale: script/style/template/svg/iframe/
 *    object/embed/noscript, and chrome regions (nav/header/footer/aside/form/
 *    button/select/dialog).
 * 2. Prefer an explicit main-content region (<article>, <main>, role="main")
 *    when one exists and carries substance; else use the stripped <body>.
 * 3. Turn block boundaries into line breaks, strip remaining tags, decode
 *    entities, collapse whitespace — clean text for the chunker.
 */

export interface ReadableHtml {
  /** The <title>, entity-decoded and trimmed; null when absent/blank. */
  title: string | null;
  /** Readable main-content text, boilerplate stripped. */
  text: string;
}

/** Subtrees that are never content — removed with everything inside them. */
const DROP_SUBTREES = [
  'script',
  'style',
  'template',
  'svg',
  'iframe',
  'object',
  'embed',
  'noscript',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'select',
  'dialog',
] as const;

/** Block-level boundaries that become line breaks so structure survives. */
const BLOCK_BREAK =
  /<\/?(?:p|div|section|article|main|br|li|ul|ol|table|tr|h[1-6]|blockquote|pre|figure|figcaption|dl|dt|dd|hr)\b[^>]*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  eur: '€',
  euro: '€',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return ' ';
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

function dropSubtree(html: string, tag: string): string {
  // Non-greedy paired removal, repeated so sibling occurrences all go; a
  // malformed unclosed tag falls through to the open-tag sweep below.
  const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
  let previous: string;
  do {
    previous = html;
    html = html.replace(paired, ' ');
  } while (html !== previous);
  return html.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
}

/** First match of an explicit main-content region, when the page marks one. */
function mainRegion(html: string): string | null {
  for (const pattern of [
    /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i,
    /<[a-z][a-z0-9]*\b[^>]*role\s*=\s*["']?main["']?[^>]*>([\s\S]*?)<\/[a-z][a-z0-9]*\s*>/i,
  ]) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function toText(fragment: string): string {
  const withBreaks = fragment
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(BLOCK_BREAK, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(withBreaks)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractReadableHtml(html: string): ReadableHtml {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]!).replace(/\s+/g, ' ').trim() : null;

  let stripped = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of DROP_SUBTREES) stripped = dropSubtree(stripped, tag);

  // Prefer the marked main region when it holds real content; a page whose
  // <article> is a stub falls back to the whole stripped body.
  const region = mainRegion(stripped);
  const regionText = region ? toText(region) : '';
  const text = regionText.length >= 200 ? regionText : toText(stripped);

  return { title: title || null, text };
}
