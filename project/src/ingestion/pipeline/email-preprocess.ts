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
  if (!text) return '';
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const base = extractInnermostForward(normalized) ?? normalized;
  const deQuoted = stripQuotedReply(base);
  const isolated = stripSignature(deQuoted).trim();
  // Never return empty for a non-empty input: if stripping consumed everything
  // (e.g. a body that was only a quote), fall back to the de-quoted-then-whole.
  return isolated || deQuoted.trim() || normalized.trim();
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
