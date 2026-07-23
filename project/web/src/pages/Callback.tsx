import { useEffect, useRef, useState } from 'react';
import { completeLogin } from '../auth/oidc';
import type { Session } from '../auth/oidc';

export function Callback({ onSession }: { onSession: (session: Session) => void }) {
  const [error, setError] = useState<string | null>(null);
  const exchanged = useRef(false);

  useEffect(() => {
    if (exchanged.current) return; // React StrictMode double-invoke; the code is single-use
    exchanged.current = true;
    completeLogin(window.location.href)
      .then((session) => {
        window.history.replaceState(null, '', '/');
        onSession(session);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [onSession]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50">
      {error ? (
        <div className="text-center">
          <p className="mb-3 text-sm text-red-600 dark:text-red-300">{error}</p>
          <a href="/" className="text-sm font-medium text-brand-navy underline">
            Back to sign-in
          </a>
        </div>
      ) : (
        <p className="text-sm text-slate-500">Completing sign-in…</p>
      )}
    </main>
  );
}
