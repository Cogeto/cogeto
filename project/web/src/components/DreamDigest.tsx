import { useQuery } from '@tanstack/react-query';
import type { DreamDigestLine } from '@cogeto/shared';
import { fetchDreamDigest } from '../api';
import type { Session } from '../auth/oidc';

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

  if (!data || data.lines.length === 0) return null;

  // `section` is optional for back-compat; absent reads as consolidation.
  const consolidation = data.lines.filter((l) => l.section !== 'tasks');
  const tasks = data.lines.filter((l) => l.section === 'tasks');

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        While you were away
      </h2>
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
            className="text-sm text-slate-700 underline decoration-slate-300 underline-offset-2 hover:text-brand-teal"
          >
            {line.text}
          </a>
        </li>
      ))}
    </ul>
  );
}
