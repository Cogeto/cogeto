import { describe, expect, it } from 'vitest';
import {
  extractInnermostForward,
  isolateEmailContent,
  stripQuotedReply,
  stripSignature,
} from './email-preprocess';

describe('email extraction pre-processing (thread-aware; Session O4)', () => {
  it('quote_stripping: quoted history and signatures are excluded; only new content remains', () => {
    const body = [
      'Hi Marko,',
      '',
      'Confirming the delivery deadline moved to Friday the 18th.',
      '',
      '-- ',
      'Ana Kovač',
      'Head of Ops, Adriatic Foods',
      '+385 91 123 4567',
      '',
      'On Mon, 6 Jul 2026 at 09:12, Marko <marko@x.com> wrote:',
      '> Can you confirm the original Wednesday date still holds?',
      '> Thanks, Marko',
    ].join('\n');

    const isolated = isolateEmailContent(body);
    expect(isolated).toContain('deadline moved to Friday');
    // Signature gone.
    expect(isolated).not.toContain('Head of Ops');
    expect(isolated).not.toContain('+385 91');
    // Quoted history gone.
    expect(isolated).not.toContain('original Wednesday date');
    expect(isolated).not.toContain('marko@x.com wrote');
  });

  it('quote_stripping: an Outlook-style "Original Message" reply is cut', () => {
    const body = [
      'Approved — go ahead and book the venue for the 20th.',
      '',
      '-----Original Message-----',
      'From: Marko',
      'Sent: Monday',
      'Subject: Venue',
      '',
      'Should we book the venue for the 20th?',
    ].join('\n');
    const isolated = isolateEmailContent(body);
    expect(isolated).toContain('book the venue for the 20th');
    expect(isolated).not.toContain('Should we book');
  });

  it('forwarded_message: the innermost forwarded content is extracted, intro + headers dropped', () => {
    const body = [
      'FYI — see below, this is the commitment we discussed.',
      '',
      '---------- Forwarded message ---------',
      'From: Luka <luka@supplier.hr>',
      'Date: Tue, 7 Jul 2026 at 14:00',
      'Subject: Delivery',
      'To: Ana <ana@adriatic-foods.hr>',
      '',
      'We will deliver the pallets to your Split warehouse by July 15.',
      'Best, Luka',
    ].join('\n');

    const isolated = isolateEmailContent(body);
    expect(isolated).toContain('deliver the pallets to your Split warehouse by July 15');
    // The carrier's intro line and the forwarded header stanza are dropped.
    expect(isolated).not.toContain('FYI — see below');
    expect(isolated).not.toContain('luka@supplier.hr');
    expect(isolated).not.toContain('Subject: Delivery');
  });

  it('forwarded_message: nested forwards take the innermost body', () => {
    const body = [
      '---------- Forwarded message ---------',
      'From: A',
      'Subject: outer',
      '',
      'Outer note.',
      '---------- Forwarded message ---------',
      'From: B',
      'Subject: inner',
      '',
      'The board approved the Q4 budget of 120k EUR.',
    ].join('\n');
    const isolated = isolateEmailContent(body);
    expect(isolated).toContain('approved the Q4 budget');
    expect(isolated).not.toContain('Outer note');
  });

  it('never empties a plain single message', () => {
    expect(isolateEmailContent('Just a quick note about lunch.')).toBe(
      'Just a quick note about lunch.',
    );
    expect(isolateEmailContent('')).toBe('');
    expect(isolateEmailContent(null)).toBe('');
  });

  it('falls back to the whole body when it is only a quote', () => {
    const body = '> everything here is quoted\n> nothing new';
    // Nothing new precedes the quote → keep the body rather than emptying it.
    expect(isolateEmailContent(body).length).toBeGreaterThan(0);
  });

  it('exposes the building blocks for reuse', () => {
    expect(stripQuotedReply('new\nOn x wrote:\n> old')).toBe('new');
    expect(stripSignature('body\n-- \nsig')).toBe('body');
    expect(extractInnermostForward('no forward here')).toBeNull();
  });
});
