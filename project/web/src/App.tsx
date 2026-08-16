import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { UNAUTHORIZED_EVENT } from './api';
import { clearSession, getWebConfig, loadSession } from './auth/oidc';
import type { Session } from './auth/oidc';
import { ConfirmProvider } from './components/confirm';
import { DemoBanner } from './components/DemoBanner';
import { DemoIntro } from './components/DemoIntro';
import { useInterfaceLanguage } from './i18n/use-language';
import { Callback } from './pages/Callback';
import { Chat } from './pages/Chat';
import { Research } from './pages/Research';
import { Dashboard } from './pages/Dashboard';
import { DemoLogin } from './pages/DemoLogin';
import { Forgotten } from './pages/Forgotten';
import { Login } from './pages/Login';
import { Approvals } from './pages/Approvals';
import { Audit } from './pages/Audit';
import { Memories } from './pages/Memories';
import { Sources } from './pages/Sources';
import { Review } from './pages/Review';
import { Reports } from './pages/Reports';
import { ModelConfiguration } from './pages/ModelConfiguration';
import { Providers } from './pages/Providers';
import { Settings } from './pages/Settings';
import { Skills } from './pages/Skills';
import { System } from './pages/System';
import { Timeline } from './pages/Timeline';
import { Users } from './pages/Users';

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

function renderPage(session: Session) {
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
    case '/audit':
      return <Audit session={session} />;
    case '/users':
      return <Users session={session} />;
    case '/providers':
      return <Providers session={session} />;
    case '/models':
      return <ModelConfiguration session={session} />;
    case '/settings':
      return <Settings session={session} />;
    case '/system':
      return <System session={session} />;
    default:
      return <Dashboard session={session} />;
  }
}
