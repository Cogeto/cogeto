import { describe, expect, it } from 'vitest';
import type { AnswerSegment } from '@cogeto/shared';
import { parseChatBlocks } from './chat-markdown';

/**
 * Markdown-lite parsing (issue #211): presentation only, after the sanitize
 * step — chips stay atomic and in order, malformed markup degrades to plain
 * text, and nothing here can resurrect a stripped token.
 */

const text = (t: string): AnswerSegment => ({ kind: 'text', text: t });
const cite = (id: string): AnswerSegment => ({ kind: 'cite', memoryId: id });
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

describe('parseChatBlocks (chat markdown-lite)', () => {
  it('styles bold, italic, and inline code within a paragraph', () => {
    const blocks = parseChatBlocks([text('Ana **leads** the *Atlas* migration in `Q3`.')]);
    expect(blocks).toHaveLength(1);
    const para = blocks[0]!;
    if (para.kind !== 'paragraph') throw new Error('expected paragraph');
    const kinds = para.lines[0]!.map((p) => p.kind);
    expect(kinds).toEqual(['text', 'bold', 'text', 'italic', 'text', 'code', 'text']);
    expect(para.lines[0]![1]).toMatchObject({ kind: 'bold', text: 'leads' });
    expect(para.lines[0]![5]).toMatchObject({ kind: 'code', text: 'Q3' });
  });

  it('groups bullet and numbered lists, splits headings and dividers', () => {
    const blocks = parseChatBlocks([
      text('### Open items\n- send the offer\n- chase the invoice\n---\n1. first\n2. second'),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'list', 'divider', 'list']);
    const [heading, bullets, , ordered] = blocks;
    expect(heading!.kind === 'heading' && heading!.content[0]).toMatchObject({
      text: 'Open items',
    });
    expect(bullets!.kind === 'list' && bullets!.items).toHaveLength(2);
    expect(bullets!.kind === 'list' && bullets!.ordered).toBe(false);
    expect(ordered!.kind === 'list' && ordered!.ordered).toBe(true);
  });

  it('keeps chips atomic, in order, inside formatted lines', () => {
    const blocks = parseChatBlocks([
      text('- **Ana** leads '),
      cite(ID),
      text('\n- Marko waits '),
      cite(ID2),
    ]);
    expect(blocks).toHaveLength(1);
    const list = blocks[0]!;
    if (list.kind !== 'list') throw new Error('expected list');
    const chips = list.items.flatMap((item) => item.filter((p) => p.kind === 'chip'));
    expect(chips.map((c) => (c.segment.kind === 'cite' ? c.segment.memoryId : ''))).toEqual([
      ID,
      ID2,
    ]);
    expect(list.items[0]![0]).toMatchObject({ kind: 'bold', text: 'Ana' });
  });

  it('a chip alone can never form a divider or heading; blank lines break paragraphs', () => {
    const blocks = parseChatBlocks([cite(ID), text('\n\nsecond paragraph')]);
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'paragraph']);
  });

  it('malformed markup degrades to literal text', () => {
    const blocks = parseChatBlocks([text('**unclosed bold and *stray'), cite(ID), text('*')]);
    const para = blocks[0]!;
    if (para.kind !== 'paragraph') throw new Error('expected paragraph');
    const flat = para.lines[0]!;
    // No styling was applied — the asterisks stay visible, the chip intact.
    expect(flat.filter((p) => p.kind === 'bold' || p.kind === 'italic')).toHaveLength(0);
    expect(flat.some((p) => p.kind === 'chip')).toBe(true);
    expect(flat[0]).toMatchObject({ kind: 'text', text: '**unclosed bold and *stray' });
  });

  it('a plain multi-line answer stays one paragraph with its line breaks', () => {
    const blocks = parseChatBlocks([text('line one\nline two')]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind === 'paragraph' && blocks[0]!.lines).toHaveLength(2);
  });
});
