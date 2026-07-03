import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session } from '../auth/oidc';
import { CaptureCard, PendingNote } from '../components/CaptureCard';
import { MemoriesPreview } from '../components/MemoriesPreview';
import { Shell } from '../components/Shell';

export function Memories({ session }: { session: Session }) {
  const [pending, setPending] = useState<string[]>([]);
  const [failedCount, setFailedCount] = useState(0);
  const queryClient = useQueryClient();

  const settle = useCallback(
    (noteId: string, failed: boolean) => {
      setPending((ids) => ids.filter((id) => id !== noteId));
      if (failed) setFailedCount((n) => n + 1);
      void queryClient.invalidateQueries({ queryKey: ['memories'] });
    },
    [queryClient],
  );

  return (
    <Shell session={session} title="Memories" active="memories">
      <CaptureCard session={session} onCaptured={(id) => setPending((ids) => [...ids, id])} />
      {pending.map((id) => (
        <PendingNote key={id} session={session} noteId={id} onSettled={settle} />
      ))}
      {failedCount > 0 && (
        <p className="text-sm text-red-600">
          {failedCount} capture{failedCount > 1 ? 's' : ''} failed processing — the job is parked in
          the dead-letter queue.
        </p>
      )}
      <MemoriesPreview session={session} />
    </Shell>
  );
}
