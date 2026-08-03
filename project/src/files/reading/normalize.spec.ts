import { describe, expect, it } from 'vitest';
import { normalizeWhitespaceReference, normalizeWhitespaceWithMap } from './normalize';

/**
 * The scanner must agree with the regex chain it replaced, on everything.
 *
 * This is the guard behind issue A2's "byte-identical" claim: the PDF and DOCX
 * readers produce their text through the scanner, so if the scanner and the
 * reference ever disagree, every document Cogeto has ever read would normalize
 * differently and the golden set would be scored against different text.
 */
describe('whitespace normalization parity', () => {
  const cases = [
    '',
    '   ',
    'plain text',
    'trailing spaces   \nnext',
    'tabs\t\tkept',
    'tab before newline\t\nnext',
    'a\r\nb',
    'a\rb',
    '\r\n\r\n\r\n',
    'three\n\n\nnewlines',
    'four\n\n\n\nnewlines',
    'blank with spaces\n \n \nafter',
    'mixed \t \n\n  \n end',
    '\n\n  leading and trailing  \n\n',
    'page one\n\npage two\n\n\npage three',
    'unicode řízek č ž š đ\n\n\nsecond',
    'windows\r\n\r\n\r\nrun',
    'a \n\n\n b',
  ];

  for (const input of cases) {
    it(`agrees on ${JSON.stringify(input)}`, () => {
      expect(normalizeWhitespaceWithMap(input).text).toBe(normalizeWhitespaceReference(input));
    });
  }

  it('agrees on a generated corpus of whitespace permutations', () => {
    const atoms = ['a', ' ', '\t', '\n', '\r', '\r\n', 'zz'];
    // Every four-atom permutation: 2401 inputs, which is where the composition
    // of "strip spaces before a newline" and "collapse newline runs" bites.
    for (const one of atoms) {
      for (const two of atoms) {
        for (const three of atoms) {
          for (const four of atoms) {
            const input = one + two + three + four;
            expect(normalizeWhitespaceWithMap(input).text, JSON.stringify(input)).toBe(
              normalizeWhitespaceReference(input),
            );
          }
        }
      }
    }
  });
});

describe('the offset map', () => {
  it('maps a raw range onto the same words in the normalized text', () => {
    const raw = 'Page one text.   \n\n\n\nPage two text.';
    const normalized = normalizeWhitespaceWithMap(raw);
    expect(normalized.text).toBe('Page one text.\n\nPage two text.');

    const secondPageStart = raw.indexOf('Page two');
    const start = normalized.map(secondPageStart);
    const end = normalized.map(raw.length);
    expect(normalized.text.slice(start, end)).toBe('Page two text.');
  });

  it('never inverts a range and never runs past the text', () => {
    const raw = '\n\n\n   first   \n\n\n\n   second   \n\n\n';
    const normalized = normalizeWhitespaceWithMap(raw);
    let previous = 0;
    for (let offset = 0; offset <= raw.length; offset += 1) {
      const mapped = normalized.map(offset);
      expect(mapped).toBeGreaterThanOrEqual(previous);
      expect(mapped).toBeLessThanOrEqual(normalized.text.length);
      previous = mapped;
    }
  });
});
