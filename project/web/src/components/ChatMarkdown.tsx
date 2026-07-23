import type { ReactNode } from 'react';
import type { AnswerSegment } from '@cogeto/shared';
import { parseChatBlocks } from './chat-markdown';
import type { ChatInline } from './chat-markdown';

/**
 * Render a chat message's sanitized segments with markdown-lite formatting
 * (issue #211). React-rendered, never innerHTML. Chips are rendered by the
 * caller (`renderChip`) so citation ordinals and drawer wiring stay where
 * they live today. Color is inherited everywhere so both bubble palettes
 * (white-on-navy user, slate-on-white assistant) work unchanged.
 */
export function ChatMarkdown({
  segments,
  renderChip,
}: {
  segments: AnswerSegment[];
  renderChip: (segment: Extract<AnswerSegment, { kind: 'cite' | 'unsourced' }>) => ReactNode;
}) {
  const blocks = parseChatBlocks(segments);
  let key = 0;
  const inline = (pieces: ChatInline[]): ReactNode =>
    pieces.map((piece) => {
      key += 1;
      if (piece.kind === 'chip') return <span key={key}>{renderChip(piece.segment)}</span>;
      if (piece.kind === 'bold')
        return (
          <strong key={key} className="font-semibold">
            {piece.text}
          </strong>
        );
      if (piece.kind === 'italic')
        return (
          <em key={key} className="italic">
            {piece.text}
          </em>
        );
      if (piece.kind === 'code')
        return (
          <code
            key={key}
            className="rounded bg-black/10 px-1 font-mono text-[0.85em] dark:bg-white/10"
          >
            {piece.text}
          </code>
        );
      return <span key={key}>{piece.text}</span>;
    });

  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((block, i) => {
        if (block.kind === 'divider')
          return <hr key={i} className="my-1 border-t border-current opacity-20" />;
        if (block.kind === 'heading')
          return (
            <p key={i} className="font-semibold">
              {inline(block.content)}
            </p>
          );
        if (block.kind === 'list')
          return block.ordered ? (
            <ol key={i} className="list-decimal space-y-0.5 pl-5">
              {block.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ol>
          ) : (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {block.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ul>
          );
        return (
          <p key={i} className="whitespace-pre-wrap">
            {block.lines.map((line, j) => (
              <span key={j}>
                {j > 0 && '\n'}
                {inline(line)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
