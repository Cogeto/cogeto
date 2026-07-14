import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EmailAllowlistKind, MemoryScope } from '@cogeto/shared';
import type { PassportExportDto } from '@cogeto/shared';
import {
  addEmailAllowlistEntry,
  fetchEmailConfig,
  fetchInstancePublicKey,
  fetchPassportDownload,
  fetchPassportExports,
  fetchSettings,
  removeEmailAllowlistEntry,
  triggerPassportExport,
  updateSettings,
} from '../api';
import type { Session } from '../auth/oidc';
import { Shell } from '../components/Shell';
import { btnPrimary, btnSecondary, SectionTitle, Skeleton } from '../components/ui';
import { timeAgo } from '../components/status';

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
          <SectionTitle>Capture &amp; upload defaults</SectionTitle>
          <p className="mt-1 text-xs text-slate-400">
            Applied to new notes and uploads. You can still override either per upload.
          </p>
        </div>

        {settings.isPending && <Skeleton className="h-24 w-full" />}
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
                className={btnPrimary}
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
              {saved && <span className="text-xs text-brand-teal-ink">Saved.</span>}
              {save.isError && (
                <span className="text-xs text-red-700">Couldn’t save — try again.</span>
              )}
            </div>
          </>
        )}
      </section>

      <EmailCaptureSection session={session} />

      <PassportSection session={session} />

      <section className="mt-4 max-w-2xl space-y-2 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <SectionTitle>Instance signing key</SectionTitle>
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
          <Skeleton className="h-16 w-full" />
        )}
        {publicKey.data && (
          <p className="text-xs text-slate-400">Algorithm: {publicKey.data.algorithm}</p>
        )}
      </section>
    </Shell>
  );
}

const PASSPORT_STATUS_LABEL: Record<PassportExportDto['status'], string> = {
  pending: 'Assembling your export…',
  ready: 'Ready to download',
  failed: 'Export failed',
  expired: 'Expired (re-export to get a fresh copy)',
};

/**
 * Memory Passport (§B.5, decision 0029): a complete, documented, versioned
 * export of the user's own data — the anti-lock-in promise made real. Assembly
 * runs in the worker; this polls the request and hands back a short-lived signed
 * download. The artifact is an open format documented in docs/passport-schema/.
 */
function PassportSection({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  const [includeOriginals, setIncludeOriginals] = useState(false);
  const exportsQuery = useQuery({
    queryKey: ['passport-exports'],
    queryFn: () => fetchPassportExports(session),
    // Poll while an export is still assembling; stop once everything settled.
    refetchInterval: (query) =>
      query.state.data?.some((row) => row.status === 'pending') ? 2000 : false,
  });
  const trigger = useMutation({
    mutationFn: () => triggerPassportExport(session, includeOriginals),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['passport-exports'] }),
  });
  const download = useMutation({
    mutationFn: async (id: string) => {
      const { url } = await fetchPassportDownload(session, id);
      window.location.href = url;
    },
  });

  const rows = exportsQuery.data ?? [];
  const pending = rows.some((row) => row.status === 'pending');

  return (
    <section className="mt-4 max-w-2xl space-y-3 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <SectionTitle>Export my data · Memory Passport</SectionTitle>
      <p className="text-xs text-slate-500">
        Download <span className="font-medium">everything</span> Cogeto knows for you — every fact
        with its status, provenance and full history, your derived tasks, and your deletion receipts
        (still independently verifiable) — in an open, documented, versioned format. Your memory is
        portable; leave whenever you want.
      </p>

      <label className="flex items-start gap-3 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={includeOriginals}
          onChange={(e) => setIncludeOriginals(e.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="font-medium">Include original files</span>
          <span className="block text-xs text-slate-400">
            Attach the original bytes of files you uploaded (a full archive). Off by default —
            provenance and metadata are always included either way.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={trigger.isPending || pending}
          onClick={() => trigger.mutate()}
          className={btnPrimary}
        >
          {trigger.isPending || pending ? 'Preparing…' : 'Export my data'}
        </button>
        {trigger.isError && (
          <span className="text-xs text-red-700">Couldn’t start the export — try again.</span>
        )}
      </div>

      {rows.length > 0 && (
        <ul className="space-y-2 border-t border-slate-100 pt-3">
          {rows.slice(0, 5).map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm"
            >
              <span className="font-mono text-xs text-slate-500">{row.filename}</span>
              <span
                className={`text-xs ${
                  row.status === 'failed'
                    ? 'text-red-700'
                    : row.status === 'ready'
                      ? 'text-brand-teal-ink'
                      : 'text-slate-400'
                }`}
              >
                {PASSPORT_STATUS_LABEL[row.status]}
                {row.status === 'failed' && row.error ? ` — ${row.error}` : ''}
              </span>
              <span className="text-xs text-slate-400" title={row.createdAt}>
                {timeAgo(row.createdAt)}
              </span>
              {row.status === 'ready' && (
                <button
                  type="button"
                  onClick={() => download.mutate(row.id)}
                  disabled={download.isPending}
                  className={`${btnSecondary} ml-auto`}
                >
                  Download
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-400">
        The format is open and documented at{' '}
        <span className="font-mono">docs/passport-schema/</span> — anyone can read and verify a
        Passport with only the schema and the instance public key above.
      </p>
    </section>
  );
}

/**
 * Email capture (Session O4, decision 0028): the instance's inbound address, the
 * sender allowlist (the control that decides whose mail Cogeto will remember),
 * and recent refusals for one-click allowlisting. The forwarding-setup guidance
 * that accompanies the address is Unit B.
 */
function EmailCaptureSection({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ['email-config'], queryFn: () => fetchEmailConfig(session) });

  const [kind, setKind] = useState<EmailAllowlistKind>('address');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['email-config'] });

  const add = useMutation({
    mutationFn: (entry: { kind: EmailAllowlistKind; value: string; note?: string | null }) =>
      addEmailAllowlistEntry(session, entry),
    onSuccess: async () => {
      setValue('');
      setNote('');
      await invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeEmailAllowlistEntry(session, id),
    onSuccess: invalidate,
  });

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) add.mutate({ kind, value: trimmed, note: note.trim() || null });
  };

  const allowlist = config.data?.allowlist ?? [];
  const refusals = config.data?.recentRefusals ?? [];
  // Senders already listed shouldn't be offered as one-click adds.
  const listed = new Set(allowlist.map((e) => e.value));

  return (
    <section className="mt-4 max-w-2xl space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div>
        <SectionTitle>Email capture</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">
          Forward, BCC, or set a provider rule to send mail to your inbound address. The sender
          allowlist below decides whose mail Cogeto will remember — until you add a sender or
          domain, no forwarded mail is accepted.
        </p>
      </div>

      {config.isPending && <Skeleton className="h-24 w-full" />}

      {config.data && (
        <>
          <div className="rounded-md bg-slate-50 p-3">
            <div className="text-xs font-medium text-slate-500">Your inbound address</div>
            {config.data.inboundAddress ? (
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-sm text-slate-700">
                  {config.data.inboundAddress}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    const addr = config.data?.inboundAddress;
                    if (addr && navigator.clipboard) {
                      void navigator.clipboard.writeText(addr);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }
                  }}
                  className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            ) : (
              <p className="mt-1 text-xs text-slate-400">
                Not configured yet — the operator sets this when provisioning the instance.
              </p>
            )}
          </div>

          {config.data.inboundAddress && (
            <div className="space-y-2 text-xs text-slate-500">
              <div className="font-medium text-slate-700">How to use it</div>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <span className="font-medium text-slate-600">Forward</span> an individual message
                  to this address to capture it.
                </li>
                <li>
                  <span className="font-medium text-slate-600">BCC</span> this address when you
                  send, to capture your own commitments as you make them.
                </li>
                <li>
                  <span className="font-medium text-slate-600">Auto-forward rule</span>: in your
                  mail provider, forward mail from selected senders here automatically.{' '}
                  <span className="text-slate-400">
                    Provider-side auto-forward (or BCC) preserves the original sender better than a
                    manual forward, so drafted replies address the right person.
                  </span>
                </li>
              </ul>
              <p className="rounded-md bg-slate-50 p-2 text-slate-500">
                Cogeto only ever receives <strong>what you forward</strong> — never your whole
                mailbox, and never your password or account access. The allowlist below decides
                whose forwarded mail is actually remembered.
              </p>
            </div>
          )}

          <div>
            <div className="text-sm font-medium text-slate-700">Allowed senders</div>
            {allowlist.length === 0 ? (
              <p className="mt-1 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                No senders allowed yet — Cogeto is <strong>closed by default</strong> and will not
                accept any forwarded mail until you add an address or domain here.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
                {allowlist.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0 text-sm text-slate-700">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                        {entry.kind}
                      </span>{' '}
                      <span className="font-mono">{entry.value}</span>
                      {entry.note && (
                        <span className="block truncate text-xs text-slate-400">{entry.note}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => remove.mutate(entry.id)}
                      disabled={remove.isPending}
                      className="shrink-0 text-xs text-red-700 hover:underline"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-500">
              <span className="block">Kind</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as EmailAllowlistKind)}
                className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
              >
                <option value="address">address</option>
                <option value="domain">domain</option>
              </select>
            </label>
            <label className="min-w-[16rem] flex-1 text-xs text-slate-500">
              <span className="block">{kind === 'address' ? 'Email address' : 'Domain'}</span>
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder={kind === 'address' ? 'ana@adriatic-foods.hr' : 'adriatic-foods.hr'}
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="min-w-[10rem] flex-1 text-xs text-slate-500">
              <span className="block">Note (optional)</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="e.g. supplier"
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <button
              type="button"
              onClick={submit}
              disabled={add.isPending || !value.trim()}
              className={btnPrimary}
            >
              Add
            </button>
          </div>
          {add.isError && (
            <p className="text-xs text-red-700">
              {add.error instanceof Error ? add.error.message : 'Couldn’t add — check the value.'}
            </p>
          )}

          {refusals.length > 0 && (
            <div>
              <div className="text-sm font-medium text-slate-700">Recently refused</div>
              <p className="text-xs text-slate-400">
                Mail Cogeto turned away because the sender wasn’t allowed. Add a legitimate sender
                in one click.
              </p>
              <ul className="mt-2 space-y-1">
                {refusals
                  .filter((r) => r.fromAddr && !listed.has(r.fromAddr))
                  .map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-1.5"
                    >
                      <span className="min-w-0 truncate text-sm text-slate-600">
                        <span className="font-mono">{r.fromAddr}</span>
                        <span className="ml-2 text-xs text-slate-400">{r.reason}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          r.fromAddr && add.mutate({ kind: 'address', value: r.fromAddr })
                        }
                        disabled={add.isPending}
                        className="shrink-0 text-xs text-brand-teal-ink hover:underline"
                      >
                        Allow this sender
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
