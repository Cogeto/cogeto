import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { MARKDOWN_CONTENT_TYPE, PLAIN_TEXT_CONTENT_TYPE } from '@cogeto/shared';
import { makePdf } from '../../testing/index';
import { locateSpan } from './locator';
import { readDocument, selectReader } from './registry';

/**
 * The text reader (V2.5 item 8.2): plain text and Markdown, the format a
 * converted Confluence page uploads as.
 *
 * Every case asserts both halves of what a reader owes: the text it produced
 * and the paragraph locator behind it. Selection cases pin the one delicate
 * rule this reader added: `text/plain` is the label browsers put on any
 * textual file, so for it the extension speaks first and the CSV alias
 * behaviour survives unchanged.
 */

const MARKDOWN = [
  '# Confluence export',
  'Ana Kovac will deliver the CRM migration plan\r\nto Adriatic Foods by 15 August 2026.',
  '- Payment terms: 30 days\n- Currency: EUR',
].join('\r\n\r\n\r\n\r\n');

describe('paragraphs split on blank lines', () => {
  it('one or more blank lines separate paragraphs; CRLF is just a newline', async () => {
    const result = await readDocument(Buffer.from(MARKDOWN, 'utf8'), {
      declaredContentType: MARKDOWN_CONTENT_TYPE,
      filename: 'export.md',
    });
    expect(result.report.format).toBe('text');
    expect(result.report.granularity).toBe('paragraph');
    expect(result.report.outcome).toBe('read');
    expect(result.segments).toHaveLength(3);
    // Markdown is not parsed: the heading and the list stay literal lines.
    expect(result.text).toContain('# Confluence export');
    expect(result.text).toContain('- Payment terms: 30 days');
    // A hard-wrapped paragraph is ONE segment, both lines inside it.
    const wrapped = result.segments[1]!;
    expect(result.text.slice(wrapped.start, wrapped.end)).toBe(
      'Ana Kovac will deliver the CRM migration plan\nto Adriatic Foods by 15 August 2026.',
    );
  });

  it('locator indices are 1-based and count non-empty blocks in order', async () => {
    const result = await readDocument(Buffer.from(MARKDOWN, 'utf8'), {
      declaredContentType: MARKDOWN_CONTENT_TYPE,
    });
    expect(result.segments.map((segment) => segment.locator)).toEqual([
      { kind: 'paragraph', paragraph: 1 },
      { kind: 'paragraph', paragraph: 2 },
      { kind: 'paragraph', paragraph: 3 },
    ]);
  });

  it('locateSpan resolves a span to the paragraph that holds it', async () => {
    const result = await readDocument(Buffer.from(MARKDOWN, 'utf8'), {
      declaredContentType: MARKDOWN_CONTENT_TYPE,
    });
    expect(locateSpan(result.text, result.segments, 'CRM migration plan')).toEqual([
      { kind: 'paragraph', paragraph: 2 },
    ]);
    expect(locateSpan(result.text, result.segments, 'Payment terms: 30 days')).toEqual([
      { kind: 'paragraph', paragraph: 3 },
    ]);
    // A span from another document resolves to nothing, never to a guess.
    expect(locateSpan(result.text, result.segments, 'a sentence nobody wrote here')).toEqual([]);
  });

  it('reads whitespace-only bytes as empty rather than failing', async () => {
    const result = await readDocument(Buffer.from('  \n\n  \n', 'utf8'), {
      declaredContentType: PLAIN_TEXT_CONTENT_TYPE,
      filename: 'blank.txt',
    });
    expect(result.text).toBe('');
    expect(result.report.outcome).toBe('empty');
    expect(result.report.reasonCode).toBe('no_text');
  });
});

describe('selection: the text label, the extension hint, and the CSV alias', () => {
  const prose = Buffer.from('Adriatic Foods will pay each invoice within 15 days.', 'utf8');
  const csvish = Buffer.from('Customer,Amount\nAdriatic Foods,12500\n', 'utf8');

  it('declared text/markdown routes to the text reader', () => {
    expect(selectReader(prose, MARKDOWN_CONTENT_TYPE, null).format).toBe('text');
  });

  it('declared text/plain with a .txt name routes to the text reader', () => {
    expect(selectReader(prose, PLAIN_TEXT_CONTENT_TYPE, 'notes.txt').format).toBe('text');
  });

  it('declared text/plain with a .csv or .tsv name still routes to CSV', () => {
    expect(selectReader(csvish, PLAIN_TEXT_CONTENT_TYPE, 'orders.csv').format).toBe('csv');
    expect(selectReader(csvish, PLAIN_TEXT_CONTENT_TYPE, 'orders.tsv').format).toBe('csv');
  });

  it('the extension alone is enough when nothing else speaks', () => {
    expect(selectReader(prose, null, 'notes.md').format).toBe('text');
    expect(selectReader(prose, null, 'notes.markdown').format).toBe('text');
    expect(selectReader(prose, null, 'notes.txt').format).toBe('text');
  });

  it('a .md file whose bytes are a PDF is routed by its bytes', () => {
    const pdf = makePdf('Atlas proposal details');
    expect(selectReader(pdf, MARKDOWN_CONTENT_TYPE, 'notes.md').format).toBe('pdf');
  });
});

describe('encoding and the char cap', () => {
  it('decodes legacy single-byte text through the configured fallback', async () => {
    const croatian = 'Petar Krešimir će voditi čitanje šifri i država.';
    const bytes = iconv.encode(croatian, 'windows-1250');
    const result = await readDocument(bytes, {
      declaredContentType: PLAIN_TEXT_CONTENT_TYPE,
      filename: 'biljeske.txt',
    });
    expect(result.text).toBe(croatian);
    expect(result.report.encoding).toBe('windows-1250');
  });

  it('strict UTF-8 wins when the bytes decode cleanly, and says so', async () => {
    const result = await readDocument(Buffer.from('čitljivo bez BOM-a', 'utf8'), {
      declaredContentType: PLAIN_TEXT_CONTENT_TYPE,
      filename: 'note.txt',
    });
    expect(result.text).toBe('čitljivo bez BOM-a');
    expect(result.report.encoding).toBe('utf-8');
  });

  it('truncates at a paragraph boundary under the char cap, and reports it', async () => {
    const paragraphs = ['First paragraph, kept whole.', 'Second paragraph, kept whole.', 'Third.'];
    const text = paragraphs.join('\n\n');
    const cap = paragraphs[0]!.length + 2 + paragraphs[1]!.length;
    const result = await readDocument(Buffer.from(text, 'utf8'), {
      declaredContentType: MARKDOWN_CONTENT_TYPE,
      caps: { maxTextChars: cap },
    });
    expect(result.text).toBe(paragraphs.slice(0, 2).join('\n\n'));
    // Nothing about truncation is written INTO the text; the report carries it.
    expect(result.report.outcome).toBe('truncated');
    expect(result.report.reasonCode).toBe('text_over_cap');
    expect(result.segments).toHaveLength(2);
  });

  it('hard-cuts a single paragraph larger than the cap rather than reading nothing', async () => {
    const result = await readDocument(Buffer.from('word '.repeat(100).trim(), 'utf8'), {
      declaredContentType: PLAIN_TEXT_CONTENT_TYPE,
      caps: { maxTextChars: 40 },
    });
    expect(result.text).toHaveLength(40);
    expect(result.report.outcome).toBe('truncated');
    expect(result.report.reasonCode).toBe('text_over_cap');
  });
});
