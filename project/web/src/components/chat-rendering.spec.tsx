// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AnswerSegment } from '@cogeto/shared';
import { ChatMarkdown } from './ChatMarkdown';
import { CodeBlock } from './CodeBlock';
import { UnsourcedChip } from './UnsourcedChip';
import { initI18n } from '../i18n';

/**
 * How a chat answer renders (issue #581), for the two things a user reported:
 * code arrived as literal backticks, and the provenance marker was ordinary
 * copyable text in the middle of a sentence.
 *
 * The rules under test:
 *
 *   code_is_reproducible — a fenced block renders as a real block, its text is
 *     exact, and it is SELECTABLE and copyable, because code that cannot be
 *     copied accurately is worthless.
 *   provenance_is_not_prose — the inline marker is short and carries
 *     `select-none`, so dragging across an answer yields the sentence and not
 *     the sentence plus its markers. The opposite of the code rule, on purpose.
 */

// Real English copy, so the assertions below are about what a user reads
// rather than about key names.
await initI18n('en');

const render = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

const segments = (text: string): AnswerSegment[] => [{ kind: 'text', text }];

describe('code_is_reproducible', () => {
  const html = render(
    <ChatMarkdown
      segments={segments('```python\ndef f():\n    return 1\n```')}
      renderChip={() => null}
    />,
  );

  it('renders a real code block, not backticks in a paragraph', () => {
    expect(html).toContain('<pre');
    expect(html).toContain('<code');
    expect(html).not.toContain('```');
  });

  it('shows the language and offers a copy control', () => {
    expect(html).toContain('python');
    expect(html.toLowerCase()).toContain('copy');
  });

  it('does NOT make the code unselectable: only the chrome is', () => {
    // The label and the button are furniture; the code is the payload.
    const pre = html.slice(html.indexOf('<pre'));
    expect(pre).not.toContain('select-none');
  });

  it('scrolls rather than wraps, because a wrapped command is a wrong command', () => {
    expect(html).toContain('overflow-x-auto');
  });

  it('an unknown language still gets the block and the copy control', () => {
    const other = render(<CodeBlock code="fn main() {}" lang="rust" />);
    expect(other).toContain('<pre');
    expect(other).toContain('rust');
    expect(other.toLowerCase()).toContain('copy');
  });
});

describe('provenance_is_not_prose', () => {
  it('the inline marker is short and cannot be selected', () => {
    const html = render(<UnsourcedChip />);
    expect(html).toContain('select-none');
    // Short: one glyph plus one word, not a sentence in the middle of a line.
    const visible = html.replace(/<[^>]*>/g, '').trim();
    expect(visible.length).toBeLessThan(16);
  });

  it('the entry under the answer says in full what the badge stands for', () => {
    const html = render(<UnsourcedChip variant="entry" />);
    expect(html).toMatch(/model/i);
    expect(html).toMatch(/not from your memory/i);
    // Long enough to be an explanation rather than a second badge.
    expect(html.replace(/<[^>]*>/g, '').trim().length).toBeGreaterThan(40);
  });
});
