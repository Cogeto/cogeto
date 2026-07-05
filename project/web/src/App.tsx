import { useState } from 'react';
import { loadSession } from './auth/oidc';
import type { Session } from './auth/oidc';
import { Callback } from './pages/Callback';
import { Chat } from './pages/Chat';
import { Dashboard } from './pages/Dashboard';
import { Forgotten } from './pages/Forgotten';
import { Login } from './pages/Login';
import { Memories } from './pages/Memories';
import { Review } from './pages/Review';
import { System } from './pages/System';

/** Tiny path switch — a router dependency is still not justified. */
export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);

  if (window.location.pathname === '/callback') {
    return <Callback onSession={setSession} />;
  }
  if (!session) return <Login />;
  if (window.location.pathname === '/memories') return <Memories session={session} />;
  if (window.location.pathname === '/chat') return <Chat session={session} />;
  if (window.location.pathname === '/review') return <Review session={session} />;
  if (window.location.pathname === '/forgotten') return <Forgotten session={session} />;
  if (window.location.pathname === '/system') return <System session={session} />;
  return <Dashboard session={session} />;
}
