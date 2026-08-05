import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { Session } from '../auth/oidc';
import { GovernedMemories } from '../components/GovernedMemories';
import { MemoryDrawer } from '../components/MemoryDrawer';
import { Shell } from '../components/Shell';

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

export function Memories({ session }: { session: Session }) {
  const { t } = useTranslation('memories');
  const [openId, setOpenId] = useState<string | null>(openedFromUrl);

  const openDrawer = (memoryId: string | null) => {
    setOpenId(memoryId);
    const url = memoryId ? `/memories?open=${memoryId}` : '/memories';
    window.history.replaceState(null, '', url);
  };

  return (
    <Shell session={session} title={t('navigation:section.memories')} active="memories">
      <CapturePointer />
      <GovernedMemories session={session} onOpen={openDrawer} />
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
