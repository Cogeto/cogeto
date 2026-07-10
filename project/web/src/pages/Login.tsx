import { useState } from 'react';
import { startLogin } from '../auth/oidc';

export function Login() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      await startLogin();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <img
          src="/brand/cogeto-final-logo-horizontal.svg"
          alt="Cogeto"
          className="mx-auto mb-2 h-12"
        />
        <p className="mb-6 text-sm text-slate-500">Your mind, extended.</p>
        <button
          type="button"
          onClick={() => void onLogin()}
          disabled={busy}
          className="w-full rounded-lg bg-brand-navy px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-navy/90 disabled:opacity-50"
        >
          {busy ? 'Redirecting…' : 'Sign in'}
        </button>
        {error && (
          <p className="mt-4 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
