import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { isRegisteredSourceType } from '@cogeto/shared';
import type { ChatFactDto, MemoryStatus, SourceTypeKey } from '@cogeto/shared';
import { fetchMe, fetchMemory, fetchWebSource } from '../api';
import type { Session } from '../auth/oidc';
import { i18next } from '../i18n';
import { formatDateTime, formatDayMonth } from '../i18n/format';
import { CITATION_STALE_MS } from '../query-invalidation';
import { isPastFact, statusLabel, WARN_STATUSES } from './status';

/**
 * An inline citation chip in an assistant message. Live streams pass the fact
 * from the SSE sources event; persisted messages resolve the memory id via
 * GET /api/memories/:id. Uncertain and contradicted facts are visibly marked.
 * A web-sourced fact renders as a web chip carrying its URL and
 * fetch time, matching the research answer's treatment.
 * Clicking opens the governance drawer in place when the page provides an
 * onOpen handler (chat); otherwise it deep-links to /memories.
 */
/**
 * Friendly, short source kind for the provenance chip. The source TYPE is an
 * API value; only its display name is translated, through an explicit
 * value → key map, typed over the source-type registry's union so adding a
 * source type without deciding its chip label is a compile error. `null` and
 * an unrecognised runtime value render verbatim, as before.
 */
const CITATION_KIND_KEY: Record<SourceTypeKey, string | null> = {
  user_note: 'chat:citation.kind.note',
  chat: 'chat:citation.kind.chat',
  email: 'chat:citation.kind.email',
  web: 'chat:citation.kind.web',
  file: null,
  chat_conversation: null,
  calendar_event: null,
  task_conclusion: null,
};

function sourceKind(sourceType: string): string {
  const key = isRegisteredSourceType(sourceType) ? CITATION_KIND_KEY[sourceType] : null;
  return key ? i18next.t(key) : sourceType.replace(/_/g, ' ');
}

/**
 * The resolved fact behind a citation, however the caller got there: the SSE
 * sources event on a live turn, or `GET /api/memories/:id` on stored history.
 *
 * Extracted (issue #534) so the inline superscript, the footnote row and the
 * chip all read the SAME resolution. They share one react-query key per
 * memory, so an answer citing one fact five times still makes one request.
 */
export function useCitationTarget(session: Session, memoryId?: string, fact?: ChatFactDto) {
  const lookupId = fact ? undefined : memoryId;
  const { data } = useQuery({
    queryKey: ['memory', lookupId],
    queryFn: () => fetchMemory(session, lookupId!),
    enabled: Boolean(lookupId),
    // A cited memory's status is refreshed by targeted invalidation on any
    // governance mutation; this stale window just bounds passive drift.
    staleTime: CITATION_STALE_MS,
  });

  const target = fact
    ? {
        memoryId: fact.memoryId,
        status: fact.status,
        claim: fact.claim,
        past: fact.pastBelief,
        scope: fact.scope,
        ownerId: fact.ownerId,
        ownerName: fact.ownerName,
        sourceType: fact.sourceType,
        sourceId: fact.sourceId,
      }
    : data
      ? {
          memoryId: data.id,
          status: data.status as MemoryStatus,
          claim: data.content,
          past: isPastFact(data.status as MemoryStatus, data.validUntil),
          scope: data.scope,
          ownerId: data.ownerId,
          ownerName: data.ownerName,
          sourceType: data.sourceType,
          sourceId: data.sourceId,
        }
      : null;

  return target;
}

export function CitationChip({
  session,
  memoryId,
  fact,
  onOpen,
}: {
  session: Session;
  memoryId?: string;
  fact?: ChatFactDto;
  onOpen?: (memoryId: string) => void;
}) {
  const { t } = useTranslation('chat');
  const target = useCitationTarget(session, memoryId, fact);
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => fetchMe(session) });

  // A web-sourced fact resolves its page for the URL + fetch-time treatment
  // (built in); the drawer still holds the full provenance.
  const webSourceId = target?.sourceType === 'web' ? target.sourceId : undefined;
  const { data: webSource } = useQuery({
    queryKey: ['web-source', webSourceId],
    queryFn: () => fetchWebSource(session, webSourceId!),
    enabled: Boolean(webSourceId),
    staleTime: CITATION_STALE_MS,
  });

  if (!target) {
    return (
      <span className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-slate-200 px-1.5 align-baseline font-mono text-[0.72rem] text-slate-400">
        <span aria-hidden="true">◈</span>
        {t('citation.unresolved')}
      </span>
    );
  }
  const warn = WARN_STATUSES.includes(target.status);
  const isWeb = target.sourceType === 'web';
  const kind = sourceKind(target.sourceType);
  const dateLabel = fact?.validFrom ? formatDayMonth(fact.validFrom) : null;
  // Provenance chip: a mono "◈ kind" token, tinted by state. Warning
  // statuses win the styling contest (a disputed fact stays visibly disputed);
  // then past-belief muted, then the teal/sky memory-vs-web split.
  const tone =
    target.status === 'contradicted'
      ? 'border-red-400/40 bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
      : target.status === 'uncertain'
        ? 'border-amber-400/40 bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300'
        : target.past
          ? 'border-slate-300 bg-slate-100 text-slate-600'
          : isWeb
            ? 'border-sky-400/40 bg-sky-400/10 text-sky-700 dark:text-sky-300'
            : 'border-brand-teal/30 bg-brand-teal/10 text-brand-teal-ink dark:text-brand-teal';
  // Attribute a cited SHARED fact owned by someone else.
  const sharedByOther = target.scope === 'shared' && target.ownerId !== me?.userId;
  const ownerLabel = target.ownerName ?? t('citation.teammate');
  const className = `mx-0.5 inline-flex items-center gap-1 rounded-md border px-1.5 align-baseline font-mono text-[0.72rem] font-medium no-underline transition-shadow hover:shadow-sm ${tone}`;
  const webDetail = webSource
    ? t('citation.webDetail', {
        title: webSource.title ?? webSource.finalUrl,
        when: formatDateTime(webSource.fetchedAt),
      })
    : isWeb
      ? t('citation.fromWeb')
      : null;
  const title = [
    target.claim,
    webDetail,
    sharedByOther ? t('citation.sharedBy', { owner: ownerLabel }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const label = (
    <>
      <span aria-hidden="true" className="opacity-80">
        ◈
      </span>
      {kind}
      {dateLabel && <span className="font-normal opacity-70">· {dateLabel}</span>}
      {warn && <span aria-hidden="true">· ⚠</span>}
      {!warn && target.past && <span className="opacity-80">{t('citation.pastSuffix')}</span>}
      {sharedByOther && <span className="text-sky-700 dark:text-sky-300">· {ownerLabel}</span>}
      <span className="sr-only">
        {' '}
        {t('citation.screenReader', { kind })}
        {warn ? t('citation.screenReaderStatus', { status: statusLabel(target.status) }) : ''}
        {!warn && target.past ? t('citation.screenReaderPast') : ''}
        {sharedByOther ? t('citation.screenReaderShared', { owner: ownerLabel }) : ''}
      </span>
    </>
  );
  return onOpen ? (
    <button
      type="button"
      onClick={() => onOpen(target.memoryId)}
      title={title || undefined}
      className={className}
    >
      {label}
    </button>
  ) : (
    <a href={`/memories?open=${target.memoryId}`} title={title || undefined} className={className}>
      {label}
    </a>
  );
}

/**
 * An inline citation, as a superscript number (issue #534).
 *
 * The chip below carries fifteen to twenty-five characters of mono text, and
 * putting that INSIDE a sentence, once per claim, is what made a well-cited
 * answer hard to read. The number keys into the numbered source list at the
 * end of the answer: the same convention printed prose has used for
 * centuries, for exactly this problem. Provenance stays per-claim; it stops
 * shouting mid-sentence.
 *
 * A warning still catches the eye inline, because a contradicted or uncertain
 * fact colours the number. That is the one thing a bare footnote marker would
 * have cost, so it is bought back deliberately.
 *
 * `select-none` keeps the marker, and its screen-reader text, out of a manual
 * selection: copying a paragraph should yield the sentences, not the
 * apparatus.
 */
export function CitationRef({
  session,
  memoryId,
  fact,
  index,
  onOpen,
}: {
  session: Session;
  memoryId: string;
  fact?: ChatFactDto;
  /** 1-based, in first-cited order: the number shown and the footnote key. */
  index: number;
  onOpen?: (memoryId: string) => void;
}) {
  const { t } = useTranslation('chat');
  const target = useCitationTarget(session, memoryId, fact);
  const status = target?.status;
  const tone =
    status === 'contradicted'
      ? 'text-red-600 dark:text-red-300'
      : status === 'uncertain'
        ? 'text-amber-700 dark:text-amber-300'
        : target?.past
          ? 'text-slate-400'
          : 'text-brand-teal-ink dark:text-brand-teal';
  const className =
    `mx-px inline-block select-none align-super font-mono text-[0.62rem] font-semibold ` +
    `leading-none transition-opacity hover:opacity-70 ${tone}`;
  const label = (
    <>
      {index}
      <span className="sr-only"> {t('citation.refScreenReader', { index })}</span>
    </>
  );
  return onOpen && target ? (
    <button
      type="button"
      onClick={() => onOpen(target.memoryId)}
      title={target.claim ?? undefined}
      className={className}
    >
      {label}
    </button>
  ) : (
    <span className={className}>{label}</span>
  );
}

/**
 * One numbered entry in the answer's source list (issue #534).
 *
 * The footer used to repeat the inline chips, which made it a duplicate of
 * information the prose already carried. Now it IS the detail: the number the
 * superscript points at, the chip, and the first line of the fact itself, so
 * three cited notes can be told apart without opening any of them.
 */
export function CitationFootnote({
  session,
  memoryId,
  fact,
  index,
  onOpen,
}: {
  session: Session;
  memoryId: string;
  fact?: ChatFactDto;
  index: number;
  onOpen?: (memoryId: string) => void;
}) {
  const target = useCitationTarget(session, memoryId, fact);
  const claim = target?.claim?.replace(/\s+/g, ' ').trim();
  return (
    <li className="flex items-baseline gap-2">
      <span className="w-4 shrink-0 text-right font-mono text-[0.62rem] text-slate-400">
        {index}
      </span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-1.5">
        <CitationChip session={session} memoryId={memoryId} fact={fact} onOpen={onOpen} />
        {claim && (
          <span className="min-w-0 text-xs leading-relaxed text-slate-500">
            {claim.length > 120 ? `${claim.slice(0, 120)}…` : claim}
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * One DOCUMENT in an answer's collapsed source list (issue #534 follow-up).
 *
 * An answer over a dense document cited 52 facts from ONE file, which the
 * per-fact list rendered as fifty-two near-identical rows. Grouping by
 * document is what makes the list say something: one row per source, the
 * number the superscripts point at, and the facts underneath for when the
 * audit trail is what you came for.
 */
export function SourceFootnote({
  session,
  index,
  memoryIds,
  factFor,
  onOpen,
}: {
  session: Session;
  index: number;
  /** Every cited fact from this one document, in first-cited order. */
  memoryIds: string[];
  factFor: (id: string) => ChatFactDto | undefined;
  onOpen?: (memoryId: string) => void;
}) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const head = memoryIds[0]!;

  return (
    <li>
      <div className="flex items-baseline gap-2">
        <span className="w-4 shrink-0 text-right font-mono text-[0.62rem] text-slate-400">
          {index}
        </span>
        <span className="flex min-w-0 flex-wrap items-baseline gap-1.5">
          <CitationChip session={session} memoryId={head} fact={factFor(head)} onOpen={onOpen} />
          <button
            type="button"
            onClick={() => setOpen((was) => !was)}
            aria-expanded={open}
            className="font-mono text-[0.62rem] text-slate-400 transition-colors hover:text-brand-teal-ink dark:hover:text-brand-teal"
          >
            {open ? '▾' : '▸'} {t('answer.factsFrom', { count: memoryIds.length })}
          </button>
        </span>
      </div>
      {open && (
        <ul className="mt-1 ml-6 space-y-1">
          {memoryIds.map((id) => (
            <FactLine key={id} session={session} memoryId={id} fact={factFor(id)} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** One cited fact under its document: the claim, opening its own drawer. */
function FactLine({
  session,
  memoryId,
  fact,
  onOpen,
}: {
  session: Session;
  memoryId: string;
  fact?: ChatFactDto;
  onOpen?: (memoryId: string) => void;
}) {
  const target = useCitationTarget(session, memoryId, fact);
  const claim = target?.claim?.replace(/\s+/g, ' ').trim();
  if (!claim) return null;
  const text = claim.length > 140 ? `${claim.slice(0, 140)}…` : claim;
  const warn = target && WARN_STATUSES.includes(target.status);
  const className = `text-left text-xs leading-relaxed ${
    warn ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500'
  } hover:text-brand-teal-ink dark:hover:text-brand-teal`;
  return (
    <li>
      {onOpen ? (
        <button type="button" onClick={() => onOpen(memoryId)} className={className}>
          {text}
        </button>
      ) : (
        <span className={className}>{text}</span>
      )}
    </li>
  );
}
