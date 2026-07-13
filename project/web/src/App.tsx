import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UNAUTHORIZED_EVENT } from './api';
import { clearSession, getWebConfig, loadSession } from './auth/oidc';
import type { Session } from './auth/oidc';
import { DemoBanner } from './components/DemoBanner';
import { DemoIntro } from './components/DemoIntro';
import { Callback } from './pages/Callback';
import { Chat } from './pages/Chat';
import { Dashboard } from './pages/Dashboard';
import { DemoLogin } from './pages/DemoLogin';
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

  // Ana sandbox (decision 0022/0027): /api/config advertises demo mode + a
  // password-gated login on a demo instance. The token is NOT served here — the
  // sandbox is no longer auto-open (decision 0027).
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
  // wrong screen. On a demo instance, show the password gate (decision 0027);
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
            Loading Cogeto…
          </span>
        </main>
      );
    }
    if (demoMode) return <DemoLogin onSession={setSession} />;
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
