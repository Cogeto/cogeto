import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { MemoryScope } from '@cogeto/shared';
import { captureNote, fetchNoteStatus, fetchSettings } from '../api';
import type { Session } from '../auth/oidc';
import { btnPrimary, Card } from './ui';

/** The Memories capture card: one textarea straight into the pipeline. */
export function CaptureCard({
  session,
  onCaptured,
}: {
  session: Session;
  onCaptured: (noteId: string) => void;
}) {
  const [content, setContent] = useState('');
  // Scope prefills from the user's saved default (§A.9); an explicit choice
  // overrides it. The server applies the same default when scope is omitted.
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => fetchSettings(session) });
  const [scope, setScope] = useState<MemoryScope | null>(null);
  const effScope: MemoryScope = scope ?? settings.data?.defaultScope ?? 'private';
  const capture = useMutation({
    mutationFn: (text: string) => captureNote(session, text, effScope),
    onSuccess: (result) => onCaptured(result.id),
  });

  const submit = () => {
    const text = content.trim();
    if (!text || capture.isPending) return;
    setContent(''); // optimistic: clear immediately, the pending row tracks progress
    capture.mutate(text);
  };

  return (
    <Card>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
        }}
        placeholder="Remember this..."
        rows={3}
        className="w-full resize-y rounded-md border border-slate-300 p-3 text-sm text-slate-800 placeholder:text-slate-400 transition-colors focus:border-brand-teal"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          Scope
          <select
            value={effScope}
            onChange={(e) => setScope(e.target.value as MemoryScope)}
            className="rounded-md border border-slate-300 px-2 py-1"
            title="Shared facts are visible to everyone in your organization; private stays yours."
          >
            <option value="private">private</option>
            <option value="shared">shared</option>
          </select>
        </label>
        <p className="ml-auto text-xs text-slate-400">
          {capture.isError ? (
            <span className="text-red-700">Capture failed — try again.</span>
          ) : (
            'Facts appear below once verified.'
          )}
        </p>
        <button
          type="button"
          onClick={submit}
          disabled={!content.trim() || capture.isPending}
          className={btnPrimary}
        >
          Remember
        </button>
      </div>
    </Card>
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
      <span className="h-2 w-2 animate-pulse rounded-full bg-brand-teal" aria-hidden="true" />
      <span role="status">Remembering… extraction and verification are running.</span>
    </div>
  );
}
