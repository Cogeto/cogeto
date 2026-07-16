import { describe, expect, it } from 'vitest';
import { summarizeCalendarInvites } from './email-calendar';

/** GAP-4: deterministic VEVENT → text summary of calendar-invite parts. */
describe('summarizeCalendarInvites (GAP-4)', () => {
  const part = (ics: string, over: { contentType?: string; filename?: string } = {}) => ({
    contentType: over.contentType ?? 'text/calendar; method=REQUEST; charset=UTF-8',
    filename: over.filename ?? null,
    content: Buffer.from(ics, 'utf8'),
  });

  const invite = (over: Partial<Record<string, string>> = {}) =>
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `SUMMARY:${over.summary ?? 'Kickoff with Adriatic Foods'}`,
      `DTSTART:${over.dtstart ?? '20260720T090000Z'}`,
      `DTEND:${over.dtend ?? '20260720T100000Z'}`,
      `LOCATION:${over.location ?? 'Zagreb office, room 3'}`,
      `ORGANIZER;CN=Ana Kovač:mailto:${over.organizer ?? 'ana@adriatic-foods.hr'}`,
      `DESCRIPTION:${over.description ?? 'Bring the Q3 proposal.'}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

  it('renders a stable English summary from a text/calendar part', () => {
    const out = summarizeCalendarInvites([part(invite())]);
    expect(out).toContain('Calendar invite: Kickoff with Adriatic Foods.');
    expect(out).toContain('Starts 2026-07-20 09:00 UTC.');
    expect(out).toContain('Ends 2026-07-20 10:00 UTC.');
    expect(out).toContain('Location: Zagreb office, room 3.');
    expect(out).toContain('Organizer: Ana Kovač <ana@adriatic-foods.hr>.');
    expect(out).toContain('Bring the Q3 proposal.');
  });

  it('recognizes an .ics attachment by filename even without the MIME type', () => {
    const out = summarizeCalendarInvites([
      part(invite({ summary: 'Sastanak s klijentom' }), {
        contentType: 'application/octet-stream',
        filename: 'invite.ics',
      }),
    ]);
    expect(out).toContain('Calendar invite: Sastanak s klijentom.');
  });

  it('unfolds folded lines and unescapes TEXT values', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:Ponuda\\, revizija i po', // folded continuation on next line
      ' tpis', // RFC 5545 fold: leading space continues "SUMMARY"
      'DTSTART;VALUE=DATE:20260803',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const out = summarizeCalendarInvites([part(ics)]);
    expect(out).toContain('Calendar invite: Ponuda, revizija i potpis.');
    expect(out).toContain('Starts 2026-08-03.'); // all-day date, no time
  });

  it('returns null when there is no calendar part', () => {
    expect(
      summarizeCalendarInvites([
        { contentType: 'application/pdf', filename: 'proposal.pdf', content: Buffer.from('%PDF') },
      ]),
    ).toBeNull();
    expect(summarizeCalendarInvites([])).toBeNull();
  });

  it('summarizes multiple VEVENTs and caps the count for a hostile invite', () => {
    const many = ['BEGIN:VCALENDAR'];
    for (let i = 0; i < 50; i++) {
      many.push('BEGIN:VEVENT', `SUMMARY:Event ${i}`, 'DTSTART:20260101T000000Z', 'END:VEVENT');
    }
    many.push('END:VCALENDAR');
    const out = summarizeCalendarInvites([part(many.join('\r\n'))], 20);
    expect(out!.split('\n')).toHaveLength(20); // capped
  });

  it('ignores an empty VEVENT with no meaningful properties', () => {
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@y\r\nEND:VEVENT\r\nEND:VCALENDAR';
    expect(summarizeCalendarInvites([part(ics)])).toBeNull();
  });
});
