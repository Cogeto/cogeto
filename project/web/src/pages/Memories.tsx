import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { fetchMemoryChanges } from '../api';
import type { Session } from '../auth/oidc';
import { GovernedMemories } from '../components/GovernedMemories';
import { MemoryDrawer } from '../components/MemoryDrawer';
import { Shell } from '../components/Shell';
import { timeAgo } from '../components/status';
import { Card, ErrorState, SkeletonRows, StatusChip } from '../components/ui';

/** Reads ?open=<memory id> — chat citation chips deep-link here. */
function openedFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('open');
}

const POINTER_DISMISSED_KEY = 'cogeto-capture-pointer-dismissed';

/**
 * A brief, dismissible pointer for the capture move (V2.2 item 5.1): the note
 * field and the upload control used to live here, and a user who reaches for
 * them must find directions, not a gap. Guidance, not an apology; remove in a
 * later version once the pattern is established.
 */
function CapturePointer() {
  const { t } = useTranslation('memories');
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(POINTER_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(POINTER_DISMISSED_KEY, '1');
    } catch {
      // The pointer simply shows again next visit.
    }
    setDismissed(true);
  };
  const link = 'font-semibold underline underline-offset-2';
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-brand-teal/30 bg-brand-teal/5 px-4 py-3 text-sm text-slate-600">
      <p className="min-w-0 flex-1 leading-relaxed">
        <Trans
          i18nKey="capturePointer.body"
          ns="memories"
          components={{
            chatLink: <a href="/chat" className={link} />,
            sourcesLink: <a href="/sources" className={link} />,
          }}
        />
      </p>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 text-xs font-semibold text-slate-500 underline underline-offset-2 hover:text-slate-700"
      >
        {t('capturePointer.dismiss')}
      </button>
    </div>
  );
}

/**
 * The changed-since view (V2.2 item 5.2): the change feed since a chosen
 * date — learned, status-changed, superseded — each row opening fact detail.
 */
function ChangesSince({
  session,
  since,
  onOpen,
}: {
  session: Session;
  since: string;
  onOpen: (memoryId: string) => void;
}) {
  const { t } = useTranslation('memories');
  const changes = useQuery({
    queryKey: ['memory-changes', since],
    queryFn: () => fetchMemoryChanges(session, new Date(since).toISOString()),
  });
  if (changes.isPending) return <SkeletonRows rows={4} label={t('changes.loading')} />;
  if (changes.isError) return <ErrorState>{t('changes.error')}</ErrorState>;
  if (changes.data.length === 0) {
    return <p className="text-sm text-slate-400">{t('changes.empty')}</p>;
  }
  return (
    <ul className="space-y-2">
      {changes.data.map((change, i) => (
        <li key={`${change.memory.id}-${change.at}-${i}`}>
          <button
            type="button"
            onClick={() => onOpen(change.memory.id)}
            className="w-full rounded-md border border-slate-200 p-2.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/40"
          >
            <p className="text-slate-700">{change.memory.content}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span>{t(`changes.kind.${change.kind}`)}</span>
              {change.kind === 'status_changed' && change.detail.from && change.detail.to && (
                <span>
                  {t('changes.transition', { from: change.detail.from, to: change.detail.to })}
                </span>
              )}
              <StatusChip status={change.memory.status} />
              <span title={change.at}>{timeAgo(change.at)}</span>
            </p>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The filtered fact search (V2.2 item 5.2, issue D): the old flat list,
 * demoted and sharpened. Sources is the primary way to see what Cogeto
 * knows; this view answers the questions a fact-level filter is genuinely
 * good at — by status, sub-reason, entity, content, and changed-since.
 */
export function Memories({ session }: { session: Session }) {
  const { t } = useTranslation('memories');
  const [openId, setOpenId] = useState<string | null>(openedFromUrl);
  const [since, setSince] = useState('');

  const openDrawer = (memoryId: string | null) => {
    setOpenId(memoryId);
    const url = memoryId ? `/memories?open=${memoryId}` : '/memories';
    window.history.replaceState(null, '', url);
  };

  return (
    <Shell session={session} title={t('search.title')} active="sources">
      <CapturePointer />
      <p className="text-sm text-slate-500">
        <Trans
          i18nKey="search.explainer"
          ns="memories"
          components={{
            sourcesLink: (
              <a href="/sources" className="font-semibold underline underline-offset-2" />
            ),
          }}
        />
      </p>
      <Card>
        <label className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
          {t('changes.sinceLabel')}
          <input
            type="date"
            value={since}
            onChange={(event) => setSince(event.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs"
          />
          {since && (
            <button
              type="button"
              onClick={() => setSince('')}
              className="text-xs text-slate-400 underline underline-offset-2"
            >
              {t('changes.clear')}
            </button>
          )}
        </label>
      </Card>
      {since ? (
        <ChangesSince session={session} since={since} onOpen={openDrawer} />
      ) : (
        <GovernedMemories session={session} onOpen={openDrawer} />
      )}
      {openId && (
        <MemoryDrawer
          session={session}
          memoryId={openId}
          onClose={() => openDrawer(null)}
          onNavigate={openDrawer}
        />
      )}
    </Shell>
  );
}
