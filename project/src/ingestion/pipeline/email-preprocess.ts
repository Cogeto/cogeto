/**
 * Thread-aware extraction pre-processing for email bodies (Session O4 — email
 * source). Deterministic, model-free: before an email body is chunked and
 * extracted, isolate the NEW content of THIS message so quoted history and
 * signatures never produce memories.
 *
 * Why deterministic and not a prompt change: in a known thread the prior
 * messages are already their own sources (their own memories, their own
 * provenance), so re-extracting quoted text is both wasteful and a duplication
 * source. Quote/signature stripping is a parsing problem with reliable
 * delimiters; a prompt cannot be trusted to abstain on quoted text as
 * consistently as a delimiter cut. Shared by the email SourceReader (production)
 * and the golden-set harness (email cases) so both isolate identically.
 *
 * Forwarding: when a message's body IS an original message (the common "FYI"
 * forward), the material to remember is the innermost forwarded content; the
 * carrying email remains the provenance target (the SourceReader passes the
 * email's id downstream regardless of what this returns).
 */

/** Markers that introduce a forwarded message (its body is what we extract). */
const FORWARD_MARKERS: RegExp[] = [
  /^[ \t]*-+\s*Forwarded message\s*-+/im, // Gmail
  /^[ \t]*Begin forwarded message:/im, // Apple Mail
  /^[ \t]*-+\s*Proslijeđena poruka\s*-+/im, // Croatian (Gmail hr)
];

/** Lines that begin quoted reply history — cut here, keep everything above. */
const REPLY_ATTRIBUTION: RegExp =
  /^\s*(On\b.*\bwrote:\s*$|-{2,}\s*Original Message\s*-{2,}|Dana\b.*\b(napisao|napisala|je napisao|je napisala)|.*\bje\s+napisao\/la:\s*$|El\b.*\bescribió:|Am\b.*\bschrieb)/i;

/** Header lines inside a forwarded block's header stanza. */
const FORWARD_HEADER_LINE: RegExp =
  /^\s*(From|Sent|Date|To|Cc|Bcc|Subject|Reply-To|Od|Šalje|Poslano|Za|Predmet|Datum):/i;

/** Trailing one-liners many clients append; safe to drop from extraction input. */
const DEVICE_SIGNOFF: RegExp = /^\s*(Sent from my\b|Poslano s\b|Get Outlook for\b)/i;

/**
 * Isolate the new content of an email body for extraction. Order: unwrap the
 * innermost forwarded message (if any) → drop quoted reply history → strip the
 * signature. Falls back to the trimmed whole body when nothing is strippable,
 * so a plain single message is never emptied.
 */
export function isolateEmailContent(text: string | null | undefined): string {
  return isolateEmailContentDetailed(text).content;
}

/**
 * Where the isolated content came from (migration 0030; decision 0054) — the
 * structural half of the email authorship rule. The extracted text is the
 * message author's OWN words only when it is neither the inner content of a
 * forwarded original (someone else wrote it) nor the quoted-history fallback
 * (the body contained no new text of the author's at all).
 */
export interface IsolatedEmailContent {
  content: string;
  /** The content is a forwarded original's inner text — not the sender's words. */
  forwarded: boolean;
  /** Stripping consumed everything; the fallback returned quoted/whole text. */
  quotedFallback: boolean;
}

export function isolateEmailContentDetailed(text: string | null | undefined): IsolatedEmailContent {
  if (!text) return { content: '', forwarded: false, quotedFallback: false };
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const inner = extractInnermostForward(normalized);
  const base = inner ?? normalized;
  const deQuoted = stripQuotedReply(base);
  const isolated = stripSignature(deQuoted).trim();
  // Never return empty for a non-empty input: if stripping consumed everything
  // (e.g. a body that was only a quote), fall back to the de-quoted-then-whole.
  return {
    content: isolated || deQuoted.trim() || normalized.trim(),
    forwarded: inner !== null,
    quotedFallback: isolated === '' && (deQuoted.trim() !== '' || normalized.trim() !== ''),
  };
}

/**
 * If the body contains a forwarded message, return the innermost forwarded
 * content (its header stanza removed); else null. The LAST forward marker is
 * the innermost forward, so we split on it.
 */
export function extractInnermostForward(text: string): string | null {
  let lastIndex = -1;
  let lastEnd = -1;
  for (const marker of FORWARD_MARKERS) {
    const re = new RegExp(
      marker.source,
      marker.flags.includes('g') ? marker.flags : marker.flags + 'g',
    );
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index >= lastIndex) {
        lastIndex = m.index;
        lastEnd = m.index + m[0].length;
      }
    }
  }
  if (lastIndex < 0) return null;
  const after = text.slice(lastEnd);
  return stripForwardHeaderStanza(after);
}

/** Drops the leading From:/Date:/To:/Subject: stanza a forward prepends. */
function stripForwardHeaderStanza(body: string): string {
  const lines = body.split('\n');
  let i = 0;
  // Skip a leading blank line the marker may leave.
  while (i < lines.length && lines[i]!.trim() === '') i += 1;
  // Skip consecutive header lines.
  let sawHeader = false;
  while (i < lines.length && FORWARD_HEADER_LINE.test(lines[i]!)) {
    sawHeader = true;
    i += 1;
  }
  // Skip the blank line(s) between the header stanza and the body.
  if (sawHeader) while (i < lines.length && lines[i]!.trim() === '') i += 1;
  return lines.slice(i).join('\n');
}

/**
 * Remove quoted reply history: cut at the first attribution line and drop
 * fully-quoted (`>`-prefixed) lines. Keeps the new content that precedes the
 * quote.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (REPLY_ATTRIBUTION.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * The header set recovered from a forwarded-message block in a body (Session O4 —
 * email reply triggers). All best-effort; a field absent from the forward is null.
 */
export interface ForwardedHeaders {
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  messageId: string | null;
}

/** Maps a header key (en + hr) to our canonical field, or null to ignore. */
function canonicalHeaderKey(raw: string): keyof ForwardedHeaders | null {
  switch (raw.trim().toLowerCase()) {
    case 'from':
    case 'od':
    case 'šalje':
    case 'salje':
      return 'from';
    case 'to':
    case 'za':
      return 'to';
    case 'cc':
      return 'cc';
    case 'subject':
    case 'predmet':
      return 'subject';
    case 'date':
    case 'sent':
    case 'datum':
    case 'poslano':
      return 'date';
    case 'message-id':
      return 'messageId';
    default:
      return null;
  }
}

const HEADER_LINE_RE = /^\s*([A-Za-z][A-Za-z-]*|Od|Za|Predmet|Datum|Šalje|Poslano):\s*(.*)$/;

/**
 * Recover the ORIGINAL correspondent's headers from a forwarded message embedded
 * in a body (Session O4 — the forwarded-addressing rule). When a user forwards
 * Ana's email to Cogeto, the envelope/header From becomes the user and Ana sits
 * inside the body as a forwarded block; a reply must go to Ana, not the
 * forwarder. This parses that block's `From:/To:/Cc:/Subject:/Date:/Message-ID:`
 * stanza (en + hr labels).
 *
 * Returns null when no forwarded header stanza is present (e.g. a directly
 * received message, or an auto-forward that preserved the original From on the
 * message itself — the caller then uses the message's own From).
 */
export function parseForwardedHeaders(text: string | null | undefined): ForwardedHeaders | null {
  if (!text) return null;
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Prefer a stanza introduced by an explicit forward/original-message marker.
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const isMarker =
      FORWARD_MARKERS.some((m) => new RegExp(m.source, m.flags.replace('g', '')).test(line)) ||
      /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line);
    if (isMarker) {
      start = i + 1;
      break;
    }
  }
  // Else an Outlook-style bare stanza: a `From:`/`Od:` line that begins a run of
  // header lines (guards against a lone "From: X" sentence in prose).
  if (start < 0) {
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\s*(From|Od):\s*\S/i.test(lines[i]!) && looksLikeHeaderStanza(lines, i)) {
        start = i;
        break;
      }
    }
  }
  if (start < 0) return null;

  const headers: ForwardedHeaders = {
    from: null,
    to: null,
    cc: null,
    subject: null,
    date: null,
    messageId: null,
  };
  let i = start;
  while (i < lines.length && lines[i]!.trim() === '') i += 1;
  for (; i < lines.length; i += 1) {
    const match = HEADER_LINE_RE.exec(lines[i]!);
    if (!match) break; // the stanza ended (body begins)
    const key = canonicalHeaderKey(match[1]!);
    const value = match[2]!.trim();
    if (key && headers[key] === null && value) headers[key] = value;
  }

  // Only a stanza that actually named a sender or subject is useful.
  return headers.from || headers.subject ? headers : null;
}

/** True when line `i` (a From:/Od: line) is followed shortly by another header
 * line — a real forwarded stanza, not a "From: the desk of…" sentence. */
function looksLikeHeaderStanza(lines: string[], i: number): boolean {
  for (let j = i + 1; j < Math.min(lines.length, i + 5); j += 1) {
    const line = lines[j]!;
    if (line.trim() === '') continue;
    if (/^\s*(To|Cc|Subject|Sent|Date|Za|Predmet|Datum|Poslano):/i.test(line)) return true;
    if (!HEADER_LINE_RE.test(line)) return false;
  }
  return false;
}

/**
 * Strip a trailing signature: cut at the RFC 3676 delimiter line (`-- `), and
 * drop trailing device sign-off one-liners.
 */
export function stripSignature(text: string): string {
  const lines = text.split('\n');
  // RFC 3676 signature delimiter: a line that is exactly "-- " (or "--").
  const sigIndex = lines.findIndex((line) => line === '-- ' || line.trim() === '--');
  const body = sigIndex >= 0 ? lines.slice(0, sigIndex) : lines;
  // Drop trailing blank + device-signoff lines.
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.trim() === '' || DEVICE_SIGNOFF.test(last)) body.pop();
    else break;
  }
  return body.join('\n');
}
