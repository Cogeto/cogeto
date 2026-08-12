import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ConfirmDialog } from './ui';
import type { ConfirmRequest } from './ui';

/**
 * The product's confirmation, as one call (issue #528).
 *
 * `window.confirm` had exactly one virtue: it is synchronous and returns a
 * boolean, so a call site stays a single guard line. A modal normally costs
 * local state, a pending action and a two-step flow at every call site, and
 * seven of those is how a codebase ends up keeping the browser dialog.
 *
 * So the hook keeps the virtue and drops the browser: `await confirm({...})`
 * resolves true or false, and the guard reads almost exactly as it did.
 *
 *     const confirm = useConfirm();
 *     if (!(await confirm({ title: t('delete.question'), destructive: true }))) return null;
 *
 * One dialog exists at the app root, so nothing renders per call site and a
 * confirmation raised from inside a drawer layers correctly above it.
 */

type Confirm = (request: ConfirmRequest) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    // A missing provider must NOT silently resolve true: that would turn every
    // guarded delete into an unguarded one, which is the worst possible way
    // for a wiring mistake to show up.
    throw new Error('useConfirm requires <ConfirmProvider> above it');
  }
  return confirm;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  const confirm = useCallback<Confirm>((next) => {
    return new Promise<boolean>((resolve) => {
      // A second request while one is open answers the first as cancelled,
      // so no caller is left awaiting a promise that can never settle.
      resolveRef.current?.(false);
      resolveRef.current = resolve;
      setRequest(next);
    });
  }, []);

  const resolve = useCallback((confirmed: boolean) => {
    const pending = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    pending?.(confirmed);
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {request && <ConfirmDialog request={request} onResolve={resolve} />}
    </ConfirmContext.Provider>
  );
}
