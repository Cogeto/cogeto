import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ConversationSearchHitDto, ProjectDto } from '@cogeto/shared';
import { splitSearchSnippet } from '@cogeto/shared';
import { searchConversations } from '../api';
import type { Session } from '../auth/oidc';
import { chatLink } from './conversations-model';
import { MARKER_CLASSES } from './projects-model';
import { timeAgo } from './status';

/**
 * Finding a conversation by what was SAID in it (issue #530).
 *
 * Search is RANKING; the rail's project grouping is BROWSING. While the box
 * has text the groups give way to a flat ranked list, and clearing it brings
 * them straight back, so one surface does both and there is no second page to
 * go to. Each result still carries its project's colour, so a hit says where
 * it lives even outside its section.
 *
 * A result deep-links to the matching MESSAGE, not just the thread, through
 * the `/chat?c=…&m=…` contract the page already honours: with a long thread,
 * landing at the top would leave you scrolling for the line you searched for.
 */

/** Long enough that one keystroke is not a query, short enough to feel live. */
const DEBOUNCE_MS = 220;

export function useDebounced<T>(value: T, ms = DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** The matched words, emphasised by SPLITTING on the sentinels the server
 * wrapped them in. Never markup, so nothing here can inject anything. */
function Snippet({ snippet }: { snippet: string }) {
  return (
    <span className="mt-0.5 block text-xs leading-relaxed text-slate-400">
      {splitSearchSnippet(snippet).map((part, index) =>
        part.matched ? (
          <mark
            key={index}
            className="rounded-sm bg-brand-teal/20 px-0.5 text-slate-700 dark:text-slate-200"
          >
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

export function ConversationSearchResults({
  session,
  query,
  projects,
  activeId,
  onOpen,
}: {
  session: Session;
  /** Already debounced by the caller. */
  query: string;
  projects: ProjectDto[];
  activeId: string | null;
  onOpen: (conversationId: string, messageId: string | null) => void;
}) {
  const { t } = useTranslation('chat');
  const { data, isPending } = useQuery({
    queryKey: ['chat-search', query],
    queryFn: () => searchConversations(session, query),
    enabled: query.trim().length > 0,
  });

  if (isPending) {
    return <p className="px-1.5 py-2 text-xs text-slate-400">{t('search.searching')}</p>;
  }
  const hits = data ?? [];
  if (hits.length === 0) {
    return (
      <p className="px-1.5 py-2 text-xs leading-relaxed text-slate-400">{t('search.empty')}</p>
    );
  }

  const markerOf = (hit: ConversationSearchHitDto) => {
    const project = projects.find((p) => p.id === hit.projectId);
    return project?.marker ? MARKER_CLASSES[project.marker] : undefined;
  };

  return (
    <>
      <p className="px-1.5 pt-1 pb-1.5 font-mono text-[0.62rem] uppercase tracking-[0.1em] text-slate-400">
        {t('search.results', { count: hits.length })}
      </p>
      <ul className="space-y-1">
        {hits.map((hit) => {
          const marker = markerOf(hit);
          return (
            <li key={hit.conversationId}>
              <a
                href={chatLink(hit.conversationId, hit.messageId ?? undefined)}
                onClick={(event) => {
                  event.preventDefault();
                  onOpen(hit.conversationId, hit.messageId);
                }}
                className={`block rounded-lg border px-2.5 py-2 transition-colors ${
                  hit.conversationId === activeId
                    ? 'border-brand-teal/40 bg-brand-teal/10'
                    : 'border-transparent hover:border-slate-200 hover:bg-surface'
                }`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    {marker && (
                      <span
                        aria-hidden="true"
                        className={`inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${marker}`}
                      />
                    )}
                    <span className="truncate text-sm text-slate-700">
                      {hit.title ?? t('conversation.untitled')}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[0.62rem] text-slate-400">
                    {timeAgo(hit.updatedAt)}
                  </span>
                </span>
                {hit.snippet ? (
                  <Snippet snippet={hit.snippet} />
                ) : (
                  // Only the title matched, and the title is already on screen.
                  <span className="mt-0.5 block text-xs text-slate-400">
                    {t('search.titleMatch')}
                  </span>
                )}
                {hit.archived && (
                  <span className="mt-0.5 block font-mono text-[0.6rem] uppercase tracking-[0.08em] text-slate-400">
                    {t('search.archivedTag')}
                  </span>
                )}
              </a>
            </li>
          );
        })}
      </ul>
    </>
  );
}
