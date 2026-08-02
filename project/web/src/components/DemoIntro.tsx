import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

/**
 * Ana sandbox (§4): a first-visit overlay suggesting things to
 * try, in order. Dismissible and never blocking — a click anywhere (including
 * the backdrop) dismisses it, and it is remembered per browser so it shows once.
 * No signup prompt; the last suggestion is the money moment (the deletion
 * receipt), set up by the skill run just before it. Only
 * rendered when a demo session is active.
 */
const SEEN_KEY = 'cogeto.demo.introSeen';

/**
 * The suggestions, in order. `id` is the stable structural key; the title and
 * body are looked up as `auth:demoIntro.tries.<id>.{title,body}` so translating
 * the sandbox never means touching this list.
 */
const TRIES: { n: number; id: string; href: string }[] = [
  { n: 1, id: 'ask', href: '/chat' },
  { n: 2, id: 'resolveContradiction', href: '/review' },
  { n: 3, id: 'skillBrief', href: '/skills' },
  { n: 4, id: 'deleteReceipt', href: '/forgotten' },
];

export function DemoIntro() {
  const { t } = useTranslation('auth');
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
          <h2 className="text-lg font-semibold text-slate-800">{t('demoIntro.title')}</h2>
          <button
            type="button"
            onClick={dismiss}
            aria-label={t('common:action.dismiss')}
            className="-mr-1 -mt-1 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>
        <p className="mb-4 text-sm text-slate-500">
          <Trans
            i18nKey="demoIntro.lead"
            ns="auth"
            values={{ persona: 'Ana Kovač’s' }}
            components={{ persona: <span className="font-medium text-slate-600" /> }}
          />
        </p>
        <ol className="grid gap-3">
          {TRIES.map((entry) => (
            <li key={entry.n}>
              <a
                href={entry.href}
                className="flex gap-3 rounded-lg border border-slate-200 p-3 text-left transition hover:border-brand-teal hover:bg-brand-teal/5"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-teal-surface dark:bg-brand-teal/15 text-xs font-bold text-brand-teal-ink dark:text-brand-teal">
                  {entry.n}
                </span>
                <span>
                  <span className="block text-sm font-semibold text-slate-800">
                    {t(`demoIntro.tries.${entry.id}.title`)}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {t(`demoIntro.tries.${entry.id}.body`)}
                  </span>
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
          {t('demoIntro.explore')}
        </button>
      </div>
    </div>
  );
}
