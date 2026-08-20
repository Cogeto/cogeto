import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchSpaces, UNAUTHORIZED_EVENT } from './api';
import { clearSession, getWebConfig, loadSession } from './auth/oidc';
import type { Session } from './auth/oidc';
import { bindCurrentSpace } from './space';
import { ConfirmProvider } from './components/confirm';
import { DemoBanner } from './components/DemoBanner';
import { DemoIntro } from './components/DemoIntro';
import { useInterfaceLanguage } from './i18n/use-language';
import { Callback } from './pages/Callback';
import { InstanceArea } from './pages/InstanceArea';
import type { InstanceSection } from './pages/InstanceArea';
import { Chat } from './pages/Chat';
import { Research } from './pages/Research';
import { Dashboard } from './pages/Dashboard';
import { DemoLogin } from './pages/DemoLogin';
import { Forgotten } from './pages/Forgotten';
import { Login } from './pages/Login';
import { Approvals } from './pages/Approvals';
import { Memories } from './pages/Memories';
import { Sources } from './pages/Sources';
import { Review } from './pages/Review';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';
import { Skills } from './pages/Skills';
import { Timeline } from './pages/Timeline';

/** Tiny path switch — a router dependency is still not justified. */
export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const queryClient = useQueryClient();
  const { t } = useTranslation('common');
  // The interface language: the user's own preference, else the browser's, else
  // English (V2.0 item 3.5). Applies without a reload.
  useInterfaceLanguage(session);

  // The document title follows the interface language too, so a translated
  // instance does not keep an English browser tab.
  useEffect(() => {
    document.title = t('document.title');
  }, [t]);

  // on a 401 (token expired/revoked) drop the dead session and re-fetch
  // /api/config, so the shell re-decides between Login and the demo session from
  // fresh state instead of looping failed authed requests.
  useEffect(() => {
    const onUnauthorized = (): void => {
      clearSession();
      setSession(null);
      void queryClient.invalidateQueries({ queryKey: ['web-config'] });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [queryClient]);

  // Ana sandbox: /api/config advertises demo mode + a
  // password-gated login on a demo instance. The token is NOT served here — the
  // sandbox is no longer auto-open.
  const { data: webConfig, isPending: configPending } = useQuery({
    queryKey: ['web-config'],
    queryFn: getWebConfig,
    retry: 3,
    staleTime: Infinity,
  });
  const demoMode = webConfig?.demoMode === true;

  // The space boot gate (docs/features/spaces.md section 3): nothing renders
  // until the caller's current space is known and BOUND, because a request
  // sent without the header acts in the default space, and a page that
  // briefly showed the wrong space's data would be the worst possible first
  // impression of a sealed partition. The bind happens inside the queryFn so
  // any render that sees data also sees the bound space.
  const {
    data: spaceList,
    isError: spacesFailed,
    refetch: refetchSpaces,
  } = useQuery({
    queryKey: ['spaces'],
    queryFn: async () => {
      const list = await fetchSpaces(session!);
      bindCurrentSpace(list);
      return list;
    },
    enabled: session != null,
  });

  if (window.location.pathname === '/callback') {
    return <Callback onSession={setSession} />;
  }

  // Wait for /api/config before deciding, so a demo visitor never flashes the
  // wrong screen. On a demo instance, show the password gate;
  // otherwise the normal OIDC login.
  if (!session) {
    if (configPending) {
      return (
        <main className="grid min-h-screen place-items-center bg-slate-50 text-sm text-slate-600">
          <span className="flex items-center gap-2" role="status" aria-live="polite">
            <img
              src="/brand/cogeto-final-favicon.svg"
              alt=""
              className="h-5 w-5"
              aria-hidden="true"
            />
            {t('state.loadingApp')}
          </span>
        </main>
      );
    }
    if (demoMode) return <DemoLogin onSession={setSession} />;
    return <Login />;
  }

  // The instance area is space-independent by design (docs/features/spaces.md
  // section 3) and is exactly what an administrator needs when the backend is
  // unhealthy, so it renders WITHOUT the space boot gate below: a failed
  // spaces fetch must never trap the machine room behind the very failure it
  // would diagnose (spaces verification F9). Its shell degrades on its own
  // when the spaces list is unavailable (the back link names the product).
  const instanceSection = INSTANCE_ROUTES[window.location.pathname];
  if (instanceSection) {
    return (
      <ConfirmProvider>
        <InstanceArea session={session} section={instanceSection} />
        {demoMode && (
          <>
            <DemoIntro />
            <DemoBanner />
          </>
        )}
      </ConfirmProvider>
    );
  }

  if (!spaceList) {
    if (spacesFailed) {
      return (
        <main className="grid min-h-screen place-items-center bg-slate-50 p-6 text-sm text-slate-600">
          <div className="text-center" role="alert">
            <p>{t('state.spacesFailed')}</p>
            <button
              type="button"
              onClick={() => void refetchSpaces()}
              className="mt-3 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
            >
              {t('action.tryAgain')}
            </button>
            {/* The door out of the trap (F9): the instance area needs no
                space, so the person who can fix this can reach the tools
                that show what is wrong. */}
            <p className="mt-4 text-xs text-slate-500">
              {t('state.spacesFailedInstanceHint')}{' '}
              <a href="/instance/system" className="font-medium underline hover:text-slate-700">
                {t('state.spacesFailedInstanceLink')}
              </a>
            </p>
          </div>
        </main>
      );
    }
    return (
      <main className="grid min-h-screen place-items-center bg-slate-50 text-sm text-slate-600">
        <span className="flex items-center gap-2" role="status" aria-live="polite">
          <img
            src="/brand/cogeto-final-favicon.svg"
            alt=""
            className="h-5 w-5"
            aria-hidden="true"
          />
          {t('state.loadingApp')}
        </span>
      </main>
    );
  }

  const page = renderPage(session);
  return (
    // One confirmation dialog for the whole app (issue #528): call sites ask
    // through `useConfirm()` and await a boolean, so none of them renders or
    // owns a modal, and a confirmation raised inside a drawer layers above it.
    <ConfirmProvider>
      {page}
      {demoMode && (
        <>
          <DemoIntro />
          <DemoBanner />
        </>
      )}
    </ConfirmProvider>
  );
}

/** The instance area's canonical routes plus the legacy paths every existing
 * deep link, banner and doc still uses; each legacy path renders the same
 * surface and is normalized to its canonical URL by the area itself. */
const INSTANCE_ROUTES: Record<string, InstanceSection> = {
  '/instance': 'settings',
  '/instance/settings': 'settings',
  '/instance/providers': 'providers',
  '/instance/models': 'models',
  '/instance/system': 'system',
  '/instance/audit': 'audit',
  '/instance/users': 'users',
  '/providers': 'providers',
  '/models': 'models',
  '/system': 'system',
  '/audit': 'audit',
  '/users': 'users',
};

function renderPage(session: Session) {
  // Instance routes never reach here: App renders them before the space boot
  // gate (F9), because the instance area is space-independent by design.
  switch (window.location.pathname) {
    case '/memories':
      return <Memories session={session} />;
    case '/sources':
      return <Sources session={session} />;
    case '/chat':
      return <Chat session={session} />;
    case '/research':
      return <Research session={session} />;
    case '/skills':
      return <Skills session={session} />;
    case '/timeline':
      return <Timeline session={session} />;
    case '/review':
      return <Review session={session} />;
    case '/reports':
      return <Reports session={session} />;
    case '/approvals':
      return <Approvals session={session} />;
    case '/forgotten':
      return <Forgotten session={session} />;
    case '/settings':
      return <Settings session={session} />;
    default:
      return <Dashboard session={session} />;
  }
}
