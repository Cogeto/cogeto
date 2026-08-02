import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Session } from '../auth/oidc';
import { MemoryDrawer } from '../components/MemoryDrawer';
import { Shell } from '../components/Shell';
import { TimelineView } from '../components/TimelineView';
import { Card, EmptyState } from '../components/ui';

type Mode = 'timeline' | 'at' | 'compare';

/** URL surface — chat citations and the memory drawer deep-link here
 * /timeline?subject=Atlas[&mode=at&at=ISO][&mode=compare&from=ISO&to=ISO]. */
function paramsFromUrl() {
  const q = new URLSearchParams(window.location.search);
  const mode = q.get('mode');
  return {
    subject: q.get('subject') ?? '',
    mode: (mode === 'at' || mode === 'compare' ? mode : 'timeline') as Mode,
    at: q.get('at') ?? undefined,
    from: q.get('from') ?? undefined,
    to: q.get('to') ?? undefined,
  };
}

export function Timeline({ session }: { session: Session }) {
  const { t } = useTranslation('timeline');
  const initial = paramsFromUrl();
  const [subject, setSubject] = useState(initial.subject);
  const [query, setQuery] = useState(initial.subject);
  const [openMemoryId, setOpenMemoryId] = useState<string | null>(null);

  const submit = (value: string) => {
    const next = value.trim();
    setSubject(next);
    window.history.replaceState(
      null,
      '',
      next ? `/timeline?subject=${encodeURIComponent(next)}` : '/timeline',
    );
  };

  return (
    <Shell session={session} title={t('navigation:section.timeline')} active="timeline">
      <Card>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit(query);
          }}
        >
          <label className="flex flex-1 flex-col gap-1 text-sm text-slate-600">
            {t('page.subjectLabel')}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('page.subjectPlaceholder')}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-teal"
            />
          </label>
          <button
            type="submit"
            disabled={!query.trim()}
            className="rounded-md bg-brand-teal px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-teal-ink disabled:opacity-40"
          >
            {t('page.viewHistory')}
          </button>
        </form>
        <p className="mt-2 text-xs text-slate-500">{t('page.explainer')}</p>
      </Card>

      {subject ? (
        <Card>
          <h2 className="mb-3 text-base font-semibold text-slate-800">{subject}</h2>
          <TimelineView
            key={subject}
            session={session}
            subject={subject}
            initialMode={initial.subject === subject ? initial.mode : 'timeline'}
            initialAt={initial.subject === subject ? initial.at : undefined}
            initialFrom={initial.subject === subject ? initial.from : undefined}
            initialTo={initial.subject === subject ? initial.to : undefined}
            onOpenMemory={setOpenMemoryId}
          />
        </Card>
      ) : (
        <EmptyState icon="🕰" title={t('page.empty.title')}>
          {t('page.empty.body')}
        </EmptyState>
      )}

      {openMemoryId && (
        <MemoryDrawer
          session={session}
          memoryId={openMemoryId}
          onClose={() => setOpenMemoryId(null)}
          onNavigate={setOpenMemoryId}
        />
      )}
    </Shell>
  );
}
