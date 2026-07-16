/**
 * Calendar-invite parsing for inbound email (Session O4 — GAP-4). A meeting
 * invite arrives as a `text/calendar` MIME part (or an `.ics` attachment); its
 * event details — summary, start/end, location, organizer — live in a VEVENT,
 * not in the human-written body. Without parsing it, an invite-only email
 * extracts weakly (the source-reader falls back to the subject), which is
 * exactly the case the v1 decision to drop the calendar connector leans on
 * ("meeting invites arrive as email and flow in for free").
 *
 * This is DETERMINISTIC and model-free — a small iCalendar (RFC 5545) reader,
 * no dependency: unfold folded lines, walk VEVENT blocks, and render a stable
 * English-labelled text summary that is appended to the extraction input (the
 * summary is persisted on the email row and added by the SourceReader AFTER
 * quote/signature isolation, so it is always seen by the extractor and is
 * covered by the deletion cascade with the row).
 */

/** A parsed attachment as mailparser presents it (only the fields we read). */
export interface CalendarPart {
  contentType?: string | null;
  filename?: string | null;
  content: Buffer;
}

/** True when a part is an iCalendar payload (by MIME type or `.ics` filename). */
function isCalendarPart(part: CalendarPart): boolean {
  const type = (part.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'text/calendar' || type === 'application/ics') return true;
  const name = (part.filename ?? '').trim().toLowerCase();
  return name.endsWith('.ics');
}

/** Unfold RFC 5545 line folding: a CRLF followed by a space/tab continues the line. */
function unfold(ics: string): string[] {
  return ics
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

/** Unescape iCalendar TEXT values (\\n \\, \\; \\\\). */
function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/**
 * Render an iCalendar date-time value to a stable, human-readable string.
 * Handles `YYYYMMDDTHHMMSSZ`, floating `YYYYMMDDTHHMMSS`, and all-day `YYYYMMDD`.
 * Falls back to the raw value when it does not match (never throws).
 */
function formatDate(raw: string): string {
  const v = raw.trim();
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (dt) {
    const [, y, mo, d, h, mi, , z] = dt;
    return `${y}-${mo}-${d} ${h}:${mi}${z ? ' UTC' : ''}`;
  }
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date) {
    const [, y, mo, d] = date;
    return `${y}-${mo}-${d}`;
  }
  return v;
}

/** The first value for a property name within one VEVENT's lines (params ignored). */
function prop(lines: string[], name: string): string | null {
  const upper = name.toUpperCase();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).split(';')[0]!.trim().toUpperCase();
    if (key === upper) return line.slice(colon + 1);
  }
  return null;
}

/** Extract the mailto/CN of an ORGANIZER-style property line. */
function formatOrganizer(lines: string[]): string | null {
  const upper = 'ORGANIZER';
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).split(';')[0]!.trim().toUpperCase();
    if (key !== upper) continue;
    const cn = /CN=([^;:]+)/i.exec(line.slice(0, colon));
    const addr = line.slice(colon + 1).replace(/^mailto:/i, '');
    const name = cn ? unescapeText(cn[1]!) : null;
    return name && addr ? `${name} <${addr}>` : name || addr || null;
  }
  return null;
}

/** Render one VEVENT block's lines to a summary sentence, or null if empty. */
function summarizeEvent(lines: string[]): string | null {
  const summary = prop(lines, 'SUMMARY');
  const start = prop(lines, 'DTSTART');
  const end = prop(lines, 'DTEND');
  const location = prop(lines, 'LOCATION');
  const description = prop(lines, 'DESCRIPTION');
  const organizer = formatOrganizer(lines);

  const parts: string[] = [];
  parts.push(`Calendar invite: ${summary ? unescapeText(summary) : '(no title)'}.`);
  if (start) parts.push(`Starts ${formatDate(start)}.`);
  if (end) parts.push(`Ends ${formatDate(end)}.`);
  if (location) parts.push(`Location: ${unescapeText(location)}.`);
  if (organizer) parts.push(`Organizer: ${organizer}.`);
  if (description) parts.push(unescapeText(description));
  // A block with nothing but the fixed lead-in carries no signal.
  if (!summary && !start && !location && !description) return null;
  return parts.join(' ');
}

/** Parse every VEVENT out of one iCalendar document into summary sentences. */
function summarizeIcs(ics: string): string[] {
  const lines = unfold(ics);
  const summaries: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^BEGIN:VEVENT$/i.test(trimmed)) current = [];
    else if (/^END:VEVENT$/i.test(trimmed)) {
      if (current) {
        const s = summarizeEvent(current);
        if (s) summaries.push(s);
      }
      current = null;
    } else if (current) current.push(line);
  }
  return summaries;
}

/**
 * Deterministic text summary of every calendar-invite part on a message, or
 * null when there is none. Bounded work — caps the number of events summarized
 * so a hostile invite with thousands of VEVENTs cannot blow up the extraction
 * input (the pipeline's own fact caps are the backstop).
 */
export function summarizeCalendarInvites(
  parts: readonly CalendarPart[],
  maxEvents = 20,
): string | null {
  const summaries: string[] = [];
  for (const part of parts) {
    if (!isCalendarPart(part)) continue;
    for (const s of summarizeIcs(part.content.toString('utf8'))) {
      summaries.push(s);
      if (summaries.length >= maxEvents) break;
    }
    if (summaries.length >= maxEvents) break;
  }
  return summaries.length > 0 ? summaries.join('\n') : null;
}
