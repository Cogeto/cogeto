import { useState } from 'react';
import { loadSession } from './auth/oidc';
import type { Session } from './auth/oidc';
import { Callback } from './pages/Callback';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';

/** Tiny path switch — a router dependency is not justified by two paths. */
export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);

  if (window.location.pathname === '/callback') {
    return <Callback onSession={setSession} />;
  }
  return session ? <Dashboard session={session} /> : <Login />;
}
