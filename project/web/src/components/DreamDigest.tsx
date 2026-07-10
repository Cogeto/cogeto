import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DreamDigestLine } from '@cogeto/shared';
import { fetchDreamDigest } from '../api';
import type { Session } from '../auth/oidc';

const DISMISSED_KEY = 'cogeto.digest.dismissed';

/**
 * "While you were away" (F2-B + O2-A): ONE surface, two sections — the nightly
 * consolidation (merges, conflicts, outdated) and tasks (due soon, overdue,
 * gone quiet). Silent nights AND an empty task set render NOTHING — no panel,
 * no noise. The tappable morning chat card is v1.x (docs/handoff/F2-dreaming.md).
 */
export function DreamDigest({ session }: { session: Session }) {
  const { data } = useQuery({
    queryKey: ['dream-digest'],
    queryFn: () => fetchDreamDigest(session),
  });
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY));

  if (!data || data.lines.length === 0) return null;
  // Dismissed until the next consolidation produces a fresh digest.
  const stamp = data.finishedAt ?? 'latest';
  if (dismissed === stamp) return null;

  // `section` is optional for back-compat; absent reads as consolidation.
  const consolidation = data.lines.filter((l) => l.section !== 'tasks');
  const tasks = data.lines.filter((l) => l.section === 'tasks');

  return (
    <section className="rounded-lg border border-slate-200 border-l-4 border-l-brand-teal/50 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <span aria-hidden="true" className="text-brand-teal-ink">
            ☾
          </span>
          While you were away
        </h2>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(DISMISSED_KEY, stamp);
            setDismissed(stamp);
          }}
          className="rounded p-1 text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-500"
          aria-label="Dismiss digest"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      {consolidation.length > 0 && <Lines lines={consolidation} />}
      {tasks.length > 0 && (
        <div className={consolidation.length > 0 ? 'mt-3 border-t border-slate-100 pt-3' : ''}>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Tasks
          </h3>
          <Lines lines={tasks} />
        </div>
      )}
      {data.finishedAt && (
        <p className="mt-2 text-xs text-slate-400">
          Nightly consolidation · {new Date(data.finishedAt).toLocaleString()}
        </p>
      )}
    </section>
  );
}

function Lines({ lines }: { lines: DreamDigestLine[] }) {
  return (
    <ul className="space-y-1.5">
      {lines.map((line) => (
        <li key={`${line.href}-${line.text}`}>
          <a
            href={line.href}
            className="text-sm text-slate-700 underline decoration-slate-300 underline-offset-2 transition-colors hover:text-brand-teal-ink"
          >
            {line.text}
          </a>
        </li>
      ))}
    </ul>
  );
}
