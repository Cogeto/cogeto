import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteSource, fetchDeletionImpact, fetchNote } from '../api';
import type { Session } from '../auth/oidc';

/**
 * The source drawer behind every memory: the original note verbatim (or the
 * object key for file sources), plus source-level TRUE deletion (§A.7, §B.1).
 * The confirm dialog states exactly what the saga will do; the server-side
 * saga is the authority — owner-only, one transaction, signed receipt.
 */
export function SourceDrawer({
  session,
  sourceType,
  sourceId,
  onClose,
  onDeleted,
}: {
  session: Session;
  sourceType: string;
  sourceId: string;
  onClose: () => void;
  /** Called after the saga accepted the deletion (receipt pending). */
  onDeleted: (receiptId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const isNote = sourceType === 'user_note';

  const noteQuery = useQuery({
    queryKey: ['note', sourceId],
    queryFn: () => fetchNote(session, sourceId),
    enabled: isNote,
  });
  const impactQuery = useQuery({
    queryKey: ['deletion-impact', sourceType, sourceId],
    queryFn: () => fetchDeletionImpact(session, sourceType, sourceId),
  });

  const remove = useMutation({
    mutationFn: () => deleteSource(session, sourceType, sourceId),
    onSuccess: async ({ receiptId }) => {
      await queryClient.invalidateQueries();
      onDeleted(receiptId);
    },
    onError: (error: unknown) =>
      setDeleteError(error instanceof Error ? error.message : String(error)),
  });

  const confirmAndDelete = () => {
    const impact = impactQuery.data;
    if (!impact) return;
    const memories = `${impact.memoryCount} derived memor${impact.memoryCount === 1 ? 'y' : 'ies'}`;
    const files =
      impact.objectCount > 0
        ? ` and ${impact.objectCount} stored file${impact.objectCount === 1 ? '' : 's'}`
        : '';
    const message =
      `This will PERMANENTLY remove this ${isNote ? 'note' : 'source'}, ${memories}${files}. ` +
      'A signed deletion receipt will be issued as proof. This cannot be undone.\n\nDelete?';
    if (window.confirm(message)) remove.mutate();
  };

  return (
    <div className="fixed inset-0 z-10" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30" />
      <aside
        className="absolute right-0 top-0 h-full w-full max-w-md space-y-3 overflow-y-auto bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Source · {isNote ? 'note' : sourceType.replace('_', ' ')}
          </h3>
          <button type="button" onClick={onClose} className="text-sm text-slate-400">
            Close
          </button>
        </div>

        {isNote && noteQuery.isPending && <p className="text-sm text-slate-400">Loading…</p>}
        {isNote && noteQuery.isError && (
          <p className="text-sm text-red-600">Could not load the note.</p>
        )}
        {isNote && noteQuery.data && (
          <>
            <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-800">
              {noteQuery.data.content}
            </p>
            <p className="text-xs text-slate-400">
              Captured {new Date(noteQuery.data.createdAt).toLocaleString()}
            </p>
          </>
        )}
        {!isNote && (
          <p className="break-all rounded-md bg-slate-50 p-3 text-xs text-slate-600">{sourceId}</p>
        )}

        {deleteError && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{deleteError}</p>
        )}

        <section className="rounded-md border border-red-200 p-3">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-600">
            Danger zone
          </h4>
          <p className="mb-2 text-xs text-slate-500">
            {impactQuery.data
              ? `Deleting this source removes it, ${impactQuery.data.memoryCount} derived ` +
                `memor${impactQuery.data.memoryCount === 1 ? 'y' : 'ies'}` +
                (impactQuery.data.objectCount > 0
                  ? ` and ${impactQuery.data.objectCount} stored file${impactQuery.data.objectCount === 1 ? '' : 's'}`
                  : '') +
                ' — permanently, with a signed receipt as proof.'
              : 'Computing what deletion would remove…'}
          </p>
          <button
            type="button"
            disabled={remove.isPending || !impactQuery.data}
            onClick={confirmAndDelete}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            {remove.isPending ? 'Deleting…' : 'Delete source…'}
          </button>
        </section>
      </aside>
    </div>
  );
}
