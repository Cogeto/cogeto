import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchMe, fetchSpaces } from '../api';
import type { Session } from '../auth/oidc';
import { currentSpaceId } from '../space';
import { ICONS } from './Nav';
import { UserMenu } from './UserMenu';

/** The instance area's sections, in nav order. `settings` holds the
 * instance-level parts of Settings and is the one everyone may use. */
export type InstanceSection = 'settings' | 'providers' | 'models' | 'system' | 'users' | 'audit';

const SECTIONS: { key: InstanceSection; adminOnly: boolean }[] = [
  { key: 'settings', adminOnly: false },
  { key: 'providers', adminOnly: true },
  { key: 'models', adminOnly: true },
  { key: 'system', adminOnly: true },
  { key: 'users', adminOnly: true },
  { key: 'audit', adminOnly: true },
];

/**
 * The display half of the instance area's role rule, as a pure function so
 * the guard spec can pin it without a container: a non-administrator sees a
 * coherent surface (their own instance-level settings), never an area full
 * of refusals. The server-side AdminGuard stays the enforcement.
 */
export function instanceNavFor(isAdmin: boolean): InstanceSection[] {
  return SECTIONS.filter((s) => !s.adminOnly || isAdmin).map((s) => s.key);
}

/**
 * The frame of the instance area (docs/features/spaces.md section 3):
 * providers, models, system, audit, users and the instance-level parts of
 * settings, moved OUT of the space-scoped sidebar and behind the navbar
 * gear. It looks deliberately different from the space shell (a light panel
 * with its own left nav, not the navy rail), because the visual separation
 * is what teaches that these surfaces belong to the deployment, not to any
 * space. The header still names the current space in the way back — the one
 * rule with no exception is that the current space is visible on every page.
 */
export function InstanceShell({
  session,
  section,
  children,
}: {
  session: Session;
  section: InstanceSection;
  children: ReactNode;
}) {
  const { t } = useTranslation('navigation');
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => fetchMe(session), retry: 1 });
  const { data: spaceList } = useQuery({
    queryKey: ['spaces'],
    queryFn: () => fetchSpaces(session),
  });
  const boundSpace = currentSpaceId();
  const spaceName =
    spaceList?.spaces.find((s) => s.id === boundSpace)?.name ?? t('common:productName');
  const sections = instanceNavFor(me?.isAdmin === true);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside
        aria-label={t('instance.title')}
        className="sticky top-0 flex h-screen w-60 shrink-0 flex-col self-start border-r border-slate-200 bg-surface"
      >
        <div className="border-b border-slate-200 p-4">
          <a
            href="/"
            className="flex items-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal"
          >
            <span aria-hidden="true">←</span>
            <span className="truncate">{t('instance.backTo', { space: spaceName })}</span>
          </a>
          <h2 className="mt-3 text-sm font-semibold text-slate-800">{t('instance.title')}</h2>
          <p className="mt-1 text-xs leading-snug text-slate-400">{t('instance.explainer')}</p>
        </div>
        <ul className="flex-1 space-y-0.5 overflow-y-auto p-3">
          {sections.map((key) => {
            const isActive = section === key;
            return (
              <li key={key}>
                <a
                  href={`/instance/${key}`}
                  aria-current={isActive ? 'page' : undefined}
                  className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-brand-teal/10 text-slate-900 ring-1 ring-inset ring-brand-teal/30'
                      : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-white/5'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`grid h-5 w-5 shrink-0 place-items-center ${
                      isActive
                        ? 'text-brand-teal-ink dark:text-brand-teal'
                        : 'text-slate-400 group-hover:text-brand-teal-ink dark:group-hover:text-brand-teal'
                    }`}
                  >
                    {ICONS[key]}
                  </span>
                  <span className="flex-1 truncate">{t(`section.${key}`)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </aside>
      <div className="flex-1">
        <header className="shrink-0 border-b border-slate-200 bg-surface">
          <div className="mx-auto flex w-full max-w-[80rem] items-center gap-2 px-6 py-2.5">
            <h1 className="min-w-0 truncate font-mono text-[0.72rem] uppercase tracking-[0.14em]">
              <span className="text-slate-400">{t('instance.title')}</span>
              <span className="mx-1.5 text-slate-300 dark:text-slate-600" aria-hidden="true">
                ·
              </span>
              <span className="font-semibold text-slate-700">{t(`section.${section}`)}</span>
            </h1>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <UserMenu userName={me?.name} orgName={me?.orgName} />
            </div>
          </div>
        </header>
        <main className="mx-auto grid w-full max-w-[80rem] gap-6 p-6">{children}</main>
      </div>
    </div>
  );
}
