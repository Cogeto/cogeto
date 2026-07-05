import { useQuery } from '@tanstack/react-query';
import { fetchDreamDigest } from '../api';
import type { Session } from '../auth/oidc';

/**
 * "While you were away" (§B.6 plain form, F2-B): the latest dreaming run's
 * work as at most six human-phrased, deep-linked lines. Silent nights render
 * NOTHING — no panel, no noise. The tappable morning chat card is v1.x
 * (docs/handoff/F2-dreaming.md).
 */
export function DreamDigest({ session }: { session: Session }) {
  const { data } = useQuery({
    queryKey: ['dream-digest'],
    queryFn: () => fetchDreamDigest(session),
  });

  if (!data || data.lines.length === 0) return null;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        While you were away
      </h2>
      <ul className="space-y-1.5">
        {data.lines.map((line) => (
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
      {data.finishedAt && (
        <p className="mt-2 text-xs text-slate-400">
          Nightly consolidation · {new Date(data.finishedAt).toLocaleString()}
        </p>
      )}
    </section>
  );
}
