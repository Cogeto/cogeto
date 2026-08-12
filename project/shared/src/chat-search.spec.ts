import { describe, expect, it } from 'vitest';
import { plainAnswerText } from './citations';
import { SEARCH_MATCH_CLOSE, SEARCH_MATCH_OPEN, splitSearchSnippet } from './chat';

/**
 * The search snippet's highlight contract (issue #530).
 *
 * The server wraps matched words in two CONTROL CHARACTERS rather than markup,
 * and the client renders emphasis by SPLITTING on them. That is the whole
 * safety argument: a snippet is user-authored chat content, and no code path
 * is ever handed it as HTML to interpret.
 */

const open = SEARCH_MATCH_OPEN;
const close = SEARCH_MATCH_CLOSE;

describe('plainAnswerText', () => {
  it('removes canonical tokens and leaves the sentence reading', () => {
    expect(
      plainAnswerText(
        'The flange ships on 12 March {{cite:3f1c2a9e-0000-4000-8000-000000000001}}.',
      ),
    ).toBe('The flange ships on 12 March.');
    expect(plainAnswerText('Model knowledge {{unsourced}} stated plainly.')).toBe(
      'Model knowledge stated plainly.',
    );
  });

  it('leaves text with no tokens untouched', () => {
    expect(plainAnswerText('Nothing to strip here.')).toBe('Nothing to strip here.');
  });
});

describe('splitSearchSnippet', () => {
  it('splits plain and matched runs in order', () => {
    expect(splitSearchSnippet(`the ${open}torque${close} is 3.2 Nm`)).toEqual([
      { text: 'the ', matched: false },
      { text: 'torque', matched: true },
      { text: ' is 3.2 Nm', matched: false },
    ]);
  });

  it('handles several matches, and a match at either end', () => {
    expect(splitSearchSnippet(`${open}a${close} b ${open}c${close}`)).toEqual([
      { text: 'a', matched: true },
      { text: ' b ', matched: false },
      { text: 'c', matched: true },
    ]);
  });

  it('never yields markup: angle brackets stay literal text', () => {
    // Chat content can contain anything. It comes back as TEXT, always.
    const parts = splitSearchSnippet(`<script>alert(1)</script> ${open}hit${close}`);
    expect(parts[0]).toEqual({ text: '<script>alert(1)</script> ', matched: false });
    expect(parts[1]).toEqual({ text: 'hit', matched: true });
  });

  it('strips a stray sentinel rather than rendering it', () => {
    // An unpaired sentinel must never reach the screen as a control character.
    const parts = splitSearchSnippet(`before ${open}orphan`);
    expect(parts.map((part) => part.text).join('')).toBe('before orphan');
    expect(parts.every((part) => !part.text.includes(open))).toBe(true);
  });

  it('returns the whole snippet unmatched when nothing was marked', () => {
    expect(splitSearchSnippet('no matches here')).toEqual([
      { text: 'no matches here', matched: false },
    ]);
  });

  it('drops empty runs so the renderer emits no empty nodes', () => {
    expect(splitSearchSnippet(`${open}${close}only`)).toEqual([{ text: 'only', matched: false }]);
  });
});
