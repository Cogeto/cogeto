import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Session } from '../auth/oidc';
import { CaptureCard, PendingNote } from '../components/CaptureCard';
import { UploadCard, PendingUpload } from '../components/UploadCard';
import type { UploadOutcome } from '../components/UploadCard';
import { GovernedMemories } from '../components/GovernedMemories';
import { MemoryDrawer } from '../components/MemoryDrawer';
import { Shell } from '../components/Shell';

/** Reads ?open=<memory id> — chat citation chips deep-link here. */
function openedFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('open');
}

export function Memories({ session }: { session: Session }) {
  const { t } = useTranslation('memories');
  const [pending, setPending] = useState<string[]>([]);
  const [uploads, setUploads] = useState<{ objectKey: string; filename: string }[]>([]);
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

  const settleUpload = useCallback(
    (objectKey: string, outcome: UploadOutcome) => {
      // A row is dropped only when the file was actually READ, because then its
      // memories appear in the list below and that is the confirmation. A
      // failed upload keeps its row for the error copy, and so does a file the
      // reader could not read: a scan needing a vision model used to disappear
      // silently and look exactly like one that had been processed (V2.1 item
      // 4.1). The queue's own state cannot tell those apart, since the job
      // succeeded in both cases.
      if (outcome === 'failed') {
        setFailedCount((n) => n + 1);
        return;
      }
      if (outcome === 'unread') return;
      setUploads((items) => items.filter((item) => item.objectKey !== objectKey));
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
    <Shell session={session} title={t('navigation:section.memories')} active="memories">
      <div className="grid gap-3 md:grid-cols-2">
        <CaptureCard session={session} onCaptured={(id) => setPending((ids) => [...ids, id])} />
        <UploadCard
          session={session}
          onUploaded={(objectKey, filename) =>
            setUploads((items) => [...items, { objectKey, filename }])
          }
        />
      </div>
      {pending.map((id) => (
        <PendingNote key={id} session={session} noteId={id} onSettled={settle} />
      ))}
      {uploads.map((upload) => (
        <PendingUpload
          key={upload.objectKey}
          session={session}
          objectKey={upload.objectKey}
          filename={upload.filename}
          onSettled={settleUpload}
        />
      ))}
      {failedCount > 0 && (
        <p className="text-sm text-red-600 dark:text-red-300">
          {t('capturesFailed', { count: failedCount })}
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
