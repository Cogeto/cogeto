import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { completeLogin } from '../auth/oidc';
import type { Session } from '../auth/oidc';
import { useApiErrorMessage } from '../i18n/api-error';

export function Callback({ onSession }: { onSession: (session: Session) => void }) {
  const { t } = useTranslation('auth');
  const apiError = useApiErrorMessage(t);
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
      .catch((e: unknown) => setError(apiError(e)));
  }, [onSession]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50">
      {error ? (
        <div className="text-center">
          <p className="mb-3 text-sm text-red-600 dark:text-red-300">{error}</p>
          <a href="/" className="text-sm font-medium text-brand-navy underline">
            {t('callback.backToSignIn')}
          </a>
        </div>
      ) : (
        <p className="text-sm text-slate-500">{t('callback.completing')}</p>
      )}
    </main>
  );
}
