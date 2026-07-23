import { useMemo } from 'react';
import type { ResearchAnswerDto } from '@cogeto/shared';

/**
 * Render a research answer's [W#]/[M#] markers as traceable citation links
 * (Priority 5 Part B). Shared by the Research page and the in-chat research
 * flow (decision 0047).
 */
export function ResearchAnswer({ answer }: { answer: ResearchAnswerDto }) {
  const byMarker = useMemo(
    () => new Map(answer.citations.map((c) => [c.marker, c])),
    [answer.citations],
  );
  const parts = answer.answer.split(/(\[[WM]\d+\])/g);
  return (
    <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
      {parts.map((part, i) => {
        const citation = byMarker.get(part);
        if (!citation) return <span key={i}>{part}</span>;
        if (citation.kind === 'web') {
          return (
            <a
              key={i}
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${citation.title ?? citation.url} · fetched ${new Date(citation.fetchedAt).toLocaleString()}`}
              className="mx-0.5 rounded bg-brand-teal/10 px-1 text-xs font-medium text-brand-teal-ink dark:text-brand-teal hover:underline"
            >
              {part}
            </a>
          );
        }
        return (
          <a
            key={i}
            href={`/memories?open=${citation.memoryId}`}
            className="mx-0.5 rounded bg-slate-100 px-1 text-xs font-medium text-slate-600 hover:underline"
          >
            {part}
          </a>
        );
      })}
    </p>
  );
}
