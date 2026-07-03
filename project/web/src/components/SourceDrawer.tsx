import { useQuery } from '@tanstack/react-query';
import { fetchNote } from '../api';
import type { Session } from '../auth/oidc';

/** The source drawer behind every memory: the original note, verbatim. */
export function SourceDrawer({
  session,
  sourceId,
  onClose,
}: {
  session: Session;
  sourceId: string;
  onClose: () => void;
}) {
  const { data, isPending, isError } = useQuery({
    queryKey: ['note', sourceId],
    queryFn: () => fetchNote(session, sourceId),
  });
  return (
    <div className="fixed inset-0 z-10" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30" />
      <aside
        className="absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Source · note
          </h3>
          <button type="button" onClick={onClose} className="text-sm text-slate-400">
            Close
          </button>
        </div>
        {isPending && <p className="text-sm text-slate-400">Loading…</p>}
        {isError && <p className="text-sm text-red-600">Could not load the note.</p>}
        {data && (
          <>
            <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-800">
              {data.content}
            </p>
            <p className="mt-2 text-xs text-slate-400">
              Captured {new Date(data.createdAt).toLocaleString()}
            </p>
          </>
        )}
      </aside>
    </div>
  );
}
