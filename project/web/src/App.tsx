import { useState } from 'react';
import { loadSession } from './auth/oidc';
import type { Session } from './auth/oidc';
import { Callback } from './pages/Callback';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { Memories } from './pages/Memories';

/** Tiny path switch — a router dependency is not justified by three paths. */
export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);

  if (window.location.pathname === '/callback') {
    return <Callback onSession={setSession} />;
  }
  if (!session) return <Login />;
  if (window.location.pathname === '/memories') return <Memories session={session} />;
  return <Dashboard session={session} />;
}
