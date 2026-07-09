import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MemoryScope } from '@cogeto/shared';
import { fetchInstancePublicKey, fetchSettings, updateSettings } from '../api';
import type { Session } from '../auth/oidc';
import { Shell } from '../components/Shell';

/** Settings (§A.9, O1-C): only real, wired toggles — every control does something today. */
export function Settings({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => fetchSettings(session) });
  const publicKey = useQuery({ queryKey: ['instance-key'], queryFn: fetchInstancePublicKey });

  const [discard, setDiscard] = useState(false);
  const [scope, setScope] = useState<MemoryScope>('private');
  const [saved, setSaved] = useState(false);

  // Hydrate the form once the saved settings load.
  useEffect(() => {
    if (settings.data) {
      setDiscard(settings.data.discardByDefault);
      setScope(settings.data.defaultScope);
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => updateSettings(session, { discardByDefault: discard, defaultScope: scope }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      setTimeout(() => setSaved(false), 2500);
    },
  });

  return (
    <Shell session={session} title="Settings" active="settings">
      <section className="max-w-2xl space-y-5 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Capture &amp; upload defaults
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Applied to new notes and uploads. You can still override either per upload.
          </p>
        </div>

        {settings.isPending && <p className="text-sm text-slate-400">Loading…</p>}
        {settings.data && (
          <>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={discard}
                onChange={(e) => setDiscard(e.target.checked)}
                className="mt-1"
              />
              <span className="text-sm text-slate-700">
                <span className="font-medium">Extract and discard by default</span>
                <span className="block text-xs text-slate-400">
                  Delete the original file after its facts are extracted — keep only the verified
                  memories. Nothing durable is stored; the derived memories retain full provenance.
                </span>
              </span>
            </label>

            <label className="flex items-center gap-3 text-sm text-slate-700">
              <span className="font-medium">Default scope</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as MemoryScope)}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
              >
                <option value="private">private</option>
                <option value="shared">shared</option>
              </select>
              <span className="text-xs text-slate-400">
                Shared memories become visible to your organization (full org sharing lands in a
                later session).
              </span>
            </label>

            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={save.isPending}
                onClick={() => save.mutate()}
                className="rounded-md bg-brand-teal px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
              {saved && <span className="text-xs text-brand-teal">Saved.</span>}
              {save.isError && <span className="text-xs text-red-600">Could not save.</span>}
            </div>
          </>
        )}
      </section>

      <section className="mt-4 max-w-2xl space-y-2 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Instance signing key
        </h2>
        <p className="text-xs text-slate-500">
          Every deletion receipt is signed with this instance's private key (§B.1). Anyone can
          verify a receipt or the Forgotten ledger against the public key below — proof that a
          deletion really happened, independent of Cogeto.
        </p>
        {publicKey.data ? (
          <pre className="overflow-x-auto rounded-md bg-slate-50 p-3 text-xs text-slate-600">
            {publicKey.data.publicKeyPem}
          </pre>
        ) : (
          <p className="text-sm text-slate-400">Loading…</p>
        )}
        {publicKey.data && (
          <p className="text-xs text-slate-400">Algorithm: {publicKey.data.algorithm}</p>
        )}
      </section>
    </Shell>
  );
}
