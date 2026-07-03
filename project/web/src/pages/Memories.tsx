import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session } from '../auth/oidc';
import { CaptureCard, PendingNote } from '../components/CaptureCard';
import { GovernedMemories } from '../components/GovernedMemories';
import { MemoryDrawer } from '../components/MemoryDrawer';
import { Shell } from '../components/Shell';

/** Reads ?open=<memory id> — chat citation chips deep-link here. */
function openedFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('open');
}

export function Memories({ session }: { session: Session }) {
  const [pending, setPending] = useState<string[]>([]);
  const [failedCount, setFailedCount] = useState(0);
  const [openId, setOpenId] = useState<string | null>(openedFromUrl);
  const queryClient = useQueryClient();

  const settle = useCallback(
    (noteId: string, failed: boolean) => {
      setPending((ids) => ids.filter((id) => id !== noteId));
      if (failed) setFailedCount((n) => n + 1);
      void queryClient.invalidateQueries({ queryKey: ['memories'] });
    },
    [queryClient],
  );

  const openDrawer = (memoryId: string | null) => {
    setOpenId(memoryId);
    const url = memoryId ? `/memories?open=${memoryId}` : '/memories';
    window.history.replaceState(null, '', url);
  };

  return (
    <Shell session={session} title="Memories" active="memories">
      <CaptureCard session={session} onCaptured={(id) => setPending((ids) => [...ids, id])} />
      {pending.map((id) => (
        <PendingNote key={id} session={session} noteId={id} onSettled={settle} />
      ))}
      {failedCount > 0 && (
        <p className="text-sm text-red-600">
          {failedCount} capture{failedCount > 1 ? 's' : ''} failed processing — see System for the
          dead-letter queue.
        </p>
      )}
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
