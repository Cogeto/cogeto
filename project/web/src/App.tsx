import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UNAUTHORIZED_EVENT } from './api';
import { clearSession, getWebConfig, installDemoSession, loadSession } from './auth/oidc';
import type { Session } from './auth/oidc';
import { DemoBanner } from './components/DemoBanner';
import { DemoIntro } from './components/DemoIntro';
import { Callback } from './pages/Callback';
import { Chat } from './pages/Chat';
import { Dashboard } from './pages/Dashboard';
import { Forgotten } from './pages/Forgotten';
import { Login } from './pages/Login';
import { Approvals } from './pages/Approvals';
import { Audit } from './pages/Audit';
import { Memories } from './pages/Memories';
import { Review } from './pages/Review';
import { Settings } from './pages/Settings';
import { System } from './pages/System';
import { Tasks } from './pages/Tasks';

/** Tiny path switch — a router dependency is still not justified. */
export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const queryClient = useQueryClient();

  // QS-36: on a 401 (token expired/revoked) drop the dead session and re-fetch
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

  // Ana sandbox (decision 0022): /api/config advertises demo mode + a pre-minted
  // session on a demo instance. Install it on first load so the visitor is
  // authenticated with no login screen.
  const { data: webConfig, isPending: configPending } = useQuery({
    queryKey: ['web-config'],
    queryFn: getWebConfig,
    retry: 3,
    staleTime: Infinity,
  });
  const demoMode = webConfig?.demoMode === true;

  useEffect(() => {
    if (!session && demoMode && webConfig?.demoSession?.accessToken) {
      setSession(installDemoSession(webConfig.demoSession.accessToken));
    }
  }, [session, demoMode, webConfig?.demoSession?.accessToken]);

  if (window.location.pathname === '/callback') {
    return <Callback onSession={setSession} />;
  }

  // Wait for /api/config before deciding between Login and the demo session, so
  // a demo visitor never flashes the login screen.
  if (!session) {
    if (configPending || (demoMode && webConfig?.demoSession)) {
      return (
        <main className="grid min-h-screen place-items-center bg-slate-50 text-sm text-slate-600">
          <span className="flex items-center gap-2" role="status" aria-live="polite">
            <img
              src="/brand/cogeto-final-favicon.svg"
              alt=""
              className="h-5 w-5"
              aria-hidden="true"
            />
            Loading Cogeto…
          </span>
        </main>
      );
    }
    return <Login />;
  }

  const page = renderPage(session);
  return (
    <>
      {page}
      {demoMode && (
        <>
          <DemoIntro />
          <DemoBanner />
        </>
      )}
    </>
  );
}

function renderPage(session: Session) {
  switch (window.location.pathname) {
    case '/memories':
      return <Memories session={session} />;
    case '/chat':
      return <Chat session={session} />;
    case '/tasks':
      return <Tasks session={session} />;
    case '/review':
      return <Review session={session} />;
    case '/approvals':
      return <Approvals session={session} />;
    case '/forgotten':
      return <Forgotten session={session} />;
    case '/audit':
      return <Audit session={session} />;
    case '/settings':
      return <Settings session={session} />;
    case '/system':
      return <System session={session} />;
    default:
      return <Dashboard session={session} />;
  }
}
