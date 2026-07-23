import { useState } from 'react';

/**
 * Ana sandbox (decision 0022 §4): a first-visit overlay suggesting three things
 * to try, in order. Dismissible and never blocking — a click anywhere (including
 * the backdrop) dismisses it, and it is remembered per browser so it shows once.
 * No signup prompt; the third suggestion is the money moment (the deletion
 * receipt). Only rendered when a demo session is active.
 */
const SEEN_KEY = 'cogeto.demo.introSeen';

const TRIES: { n: number; title: string; body: string; href: string }[] = [
  {
    n: 1,
    title: 'Ask what Ana promised Marko',
    body: 'Open chat and ask “What did Ana promise Marko?” The answer cites the note it came from.',
    href: '/chat',
  },
  {
    n: 2,
    title: 'Resolve the contradiction in Review',
    body: 'Ana’s go-live is recorded as both September 1 and October 1. Resolve it and watch the memory settle.',
    href: '/review',
  },
  {
    n: 3,
    title: 'Delete Ana’s contract and watch the receipt',
    body: 'In Forgotten, delete the Adriatic Foods consulting agreement and watch the deletion receipt confirm, hash-chained and signed.',
    href: '/forgotten',
  },
];

export function DemoIntro() {
  const [open, setOpen] = useState(() => localStorage.getItem(SEEN_KEY) !== '1');
  if (!open) return null;

  const dismiss = (): void => {
    localStorage.setItem(SEEN_KEY, '1');
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={dismiss}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-xl border border-slate-200 bg-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between">
          <h2 className="text-lg font-semibold text-slate-800">Welcome to the Cogeto sandbox</h2>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="-mr-1 -mt-1 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>
        <p className="mb-4 text-sm text-slate-500">
          This is <span className="font-medium text-slate-600">Ana Kovač’s</span> accrued,
          verifiable memory: fictional data, safe to explore. Three things to try:
        </p>
        <ol className="grid gap-3">
          {TRIES.map((t) => (
            <li key={t.n}>
              <a
                href={t.href}
                className="flex gap-3 rounded-lg border border-slate-200 p-3 text-left transition hover:border-brand-teal hover:bg-brand-teal/5"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-teal-surface dark:bg-brand-teal/15 text-xs font-bold text-brand-teal-ink dark:text-brand-teal">
                  {t.n}
                </span>
                <span>
                  <span className="block text-sm font-semibold text-slate-800">{t.title}</span>
                  <span className="block text-xs text-slate-500">{t.body}</span>
                </span>
              </a>
            </li>
          ))}
        </ol>
        <button
          type="button"
          onClick={dismiss}
          className="mt-4 w-full rounded-md bg-brand-teal px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          Explore the sandbox
        </button>
      </div>
    </div>
  );
}
