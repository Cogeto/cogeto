import { describe, expect, it } from 'vitest';
import type { AnswerSegment } from '@cogeto/shared';
import { parseChatBlocks } from './chat-markdown';

/**
 * Markdown-lite parsing: presentation only, after the sanitize
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

/**
 * Fenced code blocks (issue #581).
 *
 * Reported from a deployed instance: a ```python block rendered as literal
 * backticks. The worse half was invisible in that report — the code was not
 * merely unstyled, it was CORRUPTED, because every line still went through the
 * inline formatter and the line classifier. `**kwargs` came out bold, `#`
 * comments became headings, `- x` became bullets.
 */
describe('fenced code blocks', () => {
  const codeBlock = (blocks: ReturnType<typeof parseChatBlocks>, i = 0) => {
    const block = blocks[i]!;
    if (block.kind !== 'code') throw new Error(`expected code at ${i}, got ${block.kind}`);
    return block;
  };

  it('captures the language and the body verbatim', () => {
    const blocks = parseChatBlocks([text('```python\nprint("hi")\n```')]);
    expect(blocks).toHaveLength(1);
    expect(codeBlock(blocks)).toEqual({ kind: 'code', lang: 'python', code: 'print("hi")' });
  });

  it('THE BUG: nothing inside a fence is styled or classified', () => {
    const source = [
      '```python',
      '# a comment, not a heading',
      'def f(*args, **kwargs):',
      '    return 1',
      '- not a bullet',
      '1. not a list',
      '```',
    ].join('\n');
    const block = codeBlock(parseChatBlocks([text(source)]));
    // Byte-for-byte, including the indentation and every asterisk.
    expect(block.code).toBe(
      '# a comment, not a heading\ndef f(*args, **kwargs):\n    return 1\n- not a bullet\n1. not a list',
    );
  });

  it('an untagged fence is a code block with no language', () => {
    expect(codeBlock(parseChatBlocks([text('```\nplain\n```')])).lang).toBeNull();
  });

  it('accepts ~~~ fences, and a ``` inside one stays literal', () => {
    const block = codeBlock(parseChatBlocks([text('~~~md\n```js\nx\n```\n~~~')]));
    expect(block.lang).toBe('md');
    expect(block.code).toBe('```js\nx\n```');
  });

  it('an unterminated fence runs to the end rather than eating the answer as prose', () => {
    // A streaming answer shows the code it has so far.
    const block = codeBlock(parseChatBlocks([text('Here:\n```ts\nconst a = 1;')]), 1);
    expect(block.code).toBe('const a = 1;');
  });

  it('prose before and after a fence is still prose', () => {
    const blocks = parseChatBlocks([text('Try this:\n```sh\nls -la\n```\nThat lists **files**.')]);
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'code', 'paragraph']);
    const after = blocks[2]!;
    if (after.kind !== 'paragraph') throw new Error('expected paragraph');
    expect(after.lines[0]!.some((piece) => piece.kind === 'bold')).toBe(true);
  });

  it('the info string is lowercased and trimmed to the language', () => {
    expect(codeBlock(parseChatBlocks([text('```PYTHON title=x\ny\n```')])).lang).toBe('python');
  });

  it('a fence opened by a chip is not a fence', () => {
    // Same rule as headings and dividers: a marker has to be real text.
    const blocks = parseChatBlocks([cite(ID), text('```\nnot code\n')]);
    expect(blocks[0]!.kind).toBe('paragraph');
  });
});
