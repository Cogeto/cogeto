import { useMemo } from 'react';
import type { ResearchCitationDto } from '@cogeto/shared';
import { briefSegments } from './brief-answer';
import { ChatMarkdown } from './ChatMarkdown';
import { UnsourcedChip } from './UnsourcedChip';

/**
 * Render a skill brief (issue #268): the markdown-lite subset the
 * skill_brief prompt writes (### headings, dividers, bold, lists) through the
 * house ChatMarkdown renderer, with the [W#]/[M#] markers as traceable chips —
 * web markers link the page (title + fetch time on hover), memory markers link
 * the memory — and `(unsourced)` as the calm chip. Same visual language as the
 * chat and Research citations.
 */
export function BriefAnswer({
  brief,
  citations,
}: {
  brief: string;
  citations: ResearchCitationDto[];
}) {
  const segments = useMemo(() => briefSegments(brief, citations), [brief, citations]);
  const byMarker = useMemo(() => new Map(citations.map((c) => [c.marker, c])), [citations]);
  return (
    <div className="text-slate-800">
      <ChatMarkdown
        segments={segments}
        renderChip={(segment) => {
          if (segment.kind === 'unsourced') return <UnsourcedChip />;
          const citation = byMarker.get(segment.memoryId);
          if (!citation) return <span>{segment.memoryId}</span>;
          if (citation.kind === 'web') {
            return (
              <a
                href={citation.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`${citation.title ?? citation.url} · fetched ${new Date(citation.fetchedAt).toLocaleString()}`}
                className="mx-0.5 rounded bg-brand-teal/10 px-1 align-baseline font-mono text-xs font-medium text-brand-teal-ink hover:underline dark:text-brand-teal"
              >
                {citation.marker}
              </a>
            );
          }
          return (
            <a
              href={`/memories?open=${citation.memoryId}`}
              className="mx-0.5 rounded bg-slate-100 px-1 align-baseline font-mono text-xs font-medium text-slate-600 hover:underline"
            >
              {citation.marker}
            </a>
          );
        }}
      />
    </div>
  );
}
