import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MemoryListItem, MemoryStatus } from '@cogeto/shared';
import { fetchMemories } from '../api';
import type { Session } from '../auth/oidc';
import { SourceDrawer } from './SourceDrawer';

/**
 * Memories (preview) — a clearly-labeled placeholder list the S3 dashboard
 * replaces: content, status chip, sensitive badge, source link → drawer.
 */

const STATUS_CHIP: Record<MemoryStatus, string> = {
  active: 'bg-brand-teal/15 text-brand-teal',
  user_approved: 'bg-brand-teal/15 text-brand-teal',
  uncertain: 'bg-amber-100 text-amber-700',
  contradicted: 'bg-red-100 text-red-600',
  outdated: 'bg-slate-200 text-slate-500',
  replaced: 'bg-slate-200 text-slate-500',
};

function MemoryRow({ memory, onSource }: { memory: MemoryListItem; onSource: () => void }) {
  return (
    <li className="rounded-md border border-slate-200 px-3 py-2">
      <p className="text-sm text-slate-800">{memory.content}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded-full px-2 py-0.5 font-semibold ${STATUS_CHIP[memory.status]}`}>
          {memory.status.replace('_', '-')}
        </span>
        {memory.sensitive && (
          <span className="rounded-full bg-purple-100 px-2 py-0.5 font-semibold text-purple-700">
            sensitive
          </span>
        )}
        {memory.sourceType === 'user_note' ? (
          <button type="button" onClick={onSource} className="text-brand-teal hover:underline">
            source: note
          </button>
        ) : (
          <span className="text-slate-400">source: {memory.sourceType}</span>
        )}
        <span className="text-slate-400">{new Date(memory.createdAt).toLocaleString()}</span>
      </div>
    </li>
  );
}

export function MemoriesPreview({ session }: { session: Session }) {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const { data, isPending, isError } = useQuery({
    queryKey: ['memories'],
    queryFn: () => fetchMemories(session),
  });

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Memories</h2>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-400">
          preview — the full dashboard arrives in S3
        </span>
      </div>
      {isPending && <p className="text-sm text-slate-400">Loading…</p>}
      {isError && <p className="text-sm text-red-600">Could not load memories.</p>}
      {data && data.length === 0 && (
        <p className="text-sm text-slate-400">
          Nothing remembered yet. Capture a note above to see the pipeline work.
        </p>
      )}
      {data && data.length > 0 && (
        <ul className="space-y-2">
          {data.map((memory) => (
            <MemoryRow
              key={memory.id}
              memory={memory}
              onSource={() => setSourceId(memory.sourceId)}
            />
          ))}
        </ul>
      )}
      {sourceId && (
        <SourceDrawer session={session} sourceId={sourceId} onClose={() => setSourceId(null)} />
      )}
    </section>
  );
}
