import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { captureNote, fetchNoteStatus } from '../api';
import type { Session } from '../auth/oidc';

/** The Memories capture card: one textarea straight into the pipeline. */
export function CaptureCard({
  session,
  onCaptured,
}: {
  session: Session;
  onCaptured: (noteId: string) => void;
}) {
  const [content, setContent] = useState('');
  const capture = useMutation({
    mutationFn: (text: string) => captureNote(session, text),
    onSuccess: (result) => onCaptured(result.id),
  });

  const submit = () => {
    const text = content.trim();
    if (!text || capture.isPending) return;
    setContent(''); // optimistic: clear immediately, the pending row tracks progress
    capture.mutate(text);
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
        }}
        placeholder="Remember this..."
        rows={3}
        className="w-full resize-y rounded-md border border-slate-300 p-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-teal focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-slate-400">
          Extracted facts appear below once the pipeline verifies them.
        </p>
        {capture.isError && <p className="text-xs text-red-600">Capture failed — try again.</p>}
        <button
          type="button"
          onClick={submit}
          disabled={!content.trim() || capture.isPending}
          className="rounded-md bg-brand-teal px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          Remember
        </button>
      </div>
    </section>
  );
}

/** Polls one captured note's pipeline job until it settles. */
export function PendingNote({
  session,
  noteId,
  onSettled,
}: {
  session: Session;
  noteId: string;
  onSettled: (noteId: string, failed: boolean) => void;
}) {
  const { data } = useQuery({
    queryKey: ['note-status', noteId],
    queryFn: () => fetchNoteStatus(session, noteId),
    refetchInterval: 1500,
  });
  const state = data?.state ?? 'processing';

  useEffect(() => {
    if (state !== 'processing') onSettled(noteId, state === 'failed');
  }, [state, noteId, onSettled]);

  return (
    <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500">
      <span className="h-2 w-2 animate-pulse rounded-full bg-brand-teal" />
      Remembering… extraction and verification are running.
    </div>
  );
}
