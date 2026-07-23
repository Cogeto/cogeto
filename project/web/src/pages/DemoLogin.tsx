import { useState } from 'react';
import { demoLogin } from '../auth/oidc';
import type { Session } from '../auth/oidc';

/**
 * The Ana sandbox password gate (decision 0027). The demo is no longer auto-open:
 * the operator signs in with the demo username + the GENERATED password printed
 * by the seed/reset job (and written to demo-credentials.txt). On success the
 * returned session is installed and the tab becomes the demo Principal.
 */
export function DemoLogin({ onSession }: { onSession: (session: Session) => void }) {
  const [username, setUsername] = useState('ana@cogeto.localhost');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSession(await demoLogin(username.trim(), password));
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50">
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-surface p-8 shadow-sm"
      >
        <img
          src="/brand/cogeto-final-logo-horizontal.svg"
          alt="Cogeto"
          className="mx-auto mb-2 h-12"
        />
        <p className="mb-6 text-center text-sm text-slate-500">Demo sandbox: sign in</p>

        <label className="mb-3 block text-left">
          <span className="mb-1 block text-xs font-medium text-slate-600">Username</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy"
          />
        </label>

        <label className="mb-5 block text-left">
          <span className="mb-1 block text-xs font-medium text-slate-600">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy"
          />
        </label>

        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-lg bg-brand-navy px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-navy/90 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Enter the sandbox'}
        </button>

        {error && (
          <p className="mt-4 text-center text-sm text-red-700 dark:text-red-300" role="alert">
            {error}
          </p>
        )}

        <p className="mt-6 text-center text-xs text-slate-400">
          The password is printed by the demo seed/reset job and written to
          <code className="mx-1 rounded bg-slate-100 px-1">demo-credentials.txt</code>
          on the demo-config volume.
        </p>
      </form>
    </main>
  );
}
