// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { ChatFactDto } from '@cogeto/shared';
import { plainAnswerText, scanAnswer } from '@cogeto/shared';
import type { Session } from '../auth/oidc';
import { CitationFootnote, CitationRef } from './CitationChip';

/**
 * Readable citations (issue #534).
 *
 *   ref_is_a_bare_number — the inline mark is ONE character, not the chip's
 *     fifteen to twenty-five, which is what made a cited answer hard to read.
 *   ref_colours_a_warning — the one thing a bare footnote marker would have
 *     cost is bought back: a contradicted or uncertain fact still catches the
 *     eye inline.
 *   ref_is_unselectable — the marker and its screen-reader text stay out of a
 *     manual selection, so dragging over a paragraph copies the sentences.
 *   footnote_quotes_its_fact — the footer stops being a row of identical
 *     chips and becomes the key the numbers point at.
 *   copy_payload_is_prose — what the copy button puts on the clipboard has no
 *     tokens and no markers, by construction rather than by stripping twice.
 */

const session = { accessToken: 'test' } as Session;
const MEM = '3f1c2a9e-0000-4000-8000-000000000001';

const fact = (over: Partial<ChatFactDto> = {}): ChatFactDto => ({
  marker: 'F1',
  memoryId: MEM,
  claim: 'The frame ships on 12 March, confirmed by the supplier.',
  status: 'active',
  scope: 'private',
  ownerId: 'user-a',
  ownerName: null,
  sensitive: false,
  subjectEntity: 'Frame',
  sourceType: 'user_note',
  sourceId: 'note-1',
  validFrom: null,
  validUntil: null,
  signals: ['vector'],
  pastBelief: false,
  supersededBy: null,
  ...over,
});

const render = (node: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
};

describe('inline citation ref', () => {
  it('ref_is_a_bare_number, not the chip inline', () => {
    const html = render(
      <CitationRef session={session} memoryId={MEM} fact={fact()} index={2} onOpen={() => {}} />,
    );
    expect(html).toContain('>2<');
    // The chip's own vocabulary must not appear inline any more.
    expect(html).not.toContain('◈');
    expect(html).not.toContain('note');
  });

  it('ref_colours_a_warning: a disputed fact still catches the eye', () => {
    const contradicted = render(
      <CitationRef
        session={session}
        memoryId={MEM}
        fact={fact({ status: 'contradicted' })}
        index={1}
      />,
    );
    expect(contradicted).toContain('text-red-600');
    const uncertain = render(
      <CitationRef
        session={session}
        memoryId={MEM}
        fact={fact({ status: 'uncertain' })}
        index={1}
      />,
    );
    expect(uncertain).toContain('text-amber-700');
    const ordinary = render(
      <CitationRef session={session} memoryId={MEM} fact={fact()} index={1} />,
    );
    expect(ordinary).not.toContain('text-red-600');
    expect(ordinary).not.toContain('text-amber-700');
  });

  it('ref_is_unselectable, screen-reader text included', () => {
    const html = render(<CitationRef session={session} memoryId={MEM} fact={fact()} index={1} />);
    // Dragging a selection across a paragraph must not pick up the apparatus.
    expect(html).toContain('select-none');
    // But it is still announced, so the marker is not invisible to a reader.
    expect(html).toContain('sr-only');
  });

  it('ref_a11y: axe is clean', async () => {
    const host = document.createElement('div');
    host.innerHTML = render(
      <CitationRef session={session} memoryId={MEM} fact={fact()} index={1} onOpen={() => {}} />,
    );
    document.body.append(host);
    const results = await axe.run(host, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
    host.remove();
  });
});

describe('source footnote', () => {
  it('footnote_quotes_its_fact, so several notes are told apart without opening them', () => {
    const html = render(
      <CitationFootnote
        session={session}
        memoryId={MEM}
        fact={fact()}
        index={3}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('>3<');
    expect(html).toContain('The frame ships on 12 March');
    // The chip still carries the kind, so the entry says WHAT it is.
    expect(html).toContain('note');
  });

  it('footnote_truncates_a_long_fact rather than pushing the answer down the page', () => {
    const long = 'x'.repeat(400);
    const host = document.createElement('div');
    host.innerHTML = render(
      <CitationFootnote session={session} memoryId={MEM} fact={fact({ claim: long })} index={1} />,
    );
    // The VISIBLE quote is bounded. (The chip's tooltip still carries the
    // whole claim, which is where the full text belongs.)
    const quote = host.querySelector('span.text-xs')?.textContent ?? '';
    expect(quote.endsWith('…')).toBe(true);
    expect(quote.length).toBeLessThan(130);
  });
});

describe('copy payload', () => {
  it('copy_payload_is_prose: no tokens, no markers, one definition', () => {
    // What the button puts on the clipboard, derived the same way the search
    // snippets are, so the two cannot drift into different ideas of "clean".
    const stored = 'The frame ships on 12 March {{cite:' + MEM + '}} and holds {{unsourced}}.';
    const copied = plainAnswerText(stored);
    expect(copied).toBe('The frame ships on 12 March and holds.');
    expect(copied).not.toContain('{{');
    // And the segments the renderer walks agree it had two citations' worth
    // of apparatus to remove.
    const { segments } = scanAnswer(stored);
    expect(segments.filter((s) => s.kind !== 'text')).toHaveLength(2);
  });
});
