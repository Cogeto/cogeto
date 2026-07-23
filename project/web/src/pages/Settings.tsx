import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EmailAllowlistKind, MemoryScope } from '@cogeto/shared';
import type { PassportExportDto } from '@cogeto/shared';
import {
  addEmailAllowlistEntry,
  fetchEmailConfig,
  fetchInstancePublicKey,
  fetchModelConfig,
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
import { useTheme } from '../theme';
import type { Theme } from '../theme';

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
      <section className="mx-auto max-w-2xl space-y-5 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
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
                  Delete the original file after its facts are extracted. Keep only the verified
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
              {saved && (
                <span className="text-xs text-brand-teal-ink dark:text-brand-teal">Saved.</span>
              )}
              {save.isError && (
                <span className="text-xs text-red-700 dark:text-red-300">
                  Couldn’t save. Try again.
                </span>
              )}
            </div>
          </>
        )}
      </section>

      <AppearanceSection />

      <ModelConfigSection session={session} />

      <EmailCaptureSection session={session} />

      <PassportSection session={session} />

      <section className="mt-4 mx-auto max-w-2xl space-y-2 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
        <SectionTitle>Instance signing key</SectionTitle>
        <p className="text-xs text-slate-500">
          Every deletion receipt is signed with this instance's private key (§B.1). Anyone can
          verify a receipt or the Forgotten ledger against the public key below, proof that a
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

const THEMES: { key: Theme; label: string }[] = [
  { key: 'dark', label: 'Dark' },
  { key: 'light', label: 'Light' },
];

/**
 * Appearance (P6.8): the per-device light/dark choice. Dark is the product
 * default; picking here writes localStorage and applies instantly on every
 * surface, and the pre-paint bootstrap in index.html honours it on the next load
 * with no flash. A segmented control, not a checkbox: two named, explicit states.
 */
function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  return (
    <section className="mt-4 mx-auto max-w-2xl space-y-3 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>Appearance</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">
          Dark is the default. Your choice is remembered on this device and applies everywhere.
        </p>
      </div>
      <div
        role="group"
        aria-label="Theme"
        className="flex w-fit gap-1 rounded-lg bg-slate-200/70 p-1"
      >
        {THEMES.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={theme === t.key}
            onClick={() => setTheme(t.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
              theme === t.key
                ? 'bg-surface text-slate-800 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Model configuration (decision 0040): READ-ONLY display of the active
 * provider configuration — the id the trust page joins on, the provider and
 * model per tier, redaction posture, and what leaves the instance. No key
 * input, no editing: keys are operator-set in the instance environment.
 */
function ModelConfigSection({ session }: { session: Session }) {
  const config = useQuery({
    queryKey: ['model-config'],
    queryFn: () => fetchModelConfig(session),
  });

  return (
    <section className="mt-4 mx-auto max-w-2xl space-y-3 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>Model configuration</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">
          Read-only. The active providers and models are set by the operator in the instance
          environment. API keys are never entered or shown here.
        </p>
      </div>
      {config.isPending && <Skeleton className="h-24 w-full" />}
      {config.data && (
        <>
          <div className="flex items-center gap-2 text-sm text-slate-700">
            <span className="font-medium">Configuration</span>
            <code className="rounded bg-slate-50 px-2 py-0.5 text-xs text-slate-600">
              {config.data.configurationId}
            </code>
            {!config.data.configured && (
              <span className="text-xs text-amber-700 dark:text-amber-300">
                no provider key set, model features are disabled
              </span>
            )}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {(
              [
                ['Pipeline', config.data.tiers.pipeline],
                ['Answer', config.data.tiers.answer],
                ['Embeddings', config.data.tiers.embeddings],
              ] as const
            ).map(([label, tier]) => (
              <div key={label} className="contents">
                <dt className="text-slate-500">{label}</dt>
                <dd className="text-slate-700">
                  {tier.provider}/{tier.model}
                </dd>
              </div>
            ))}
            <div className="contents">
              <dt className="text-slate-500">Redaction</dt>
              <dd className="text-slate-700">{config.data.redactionEnabled ? 'on' : 'off'}</dd>
            </div>
          </dl>
          <p className="text-xs text-slate-500">{config.data.externalCalls}</p>
        </>
      )}
      {config.isError && (
        <p className="text-xs text-red-700 dark:text-red-300">
          Couldn’t load the model configuration.
        </p>
      )}
    </section>
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
    <section className="mt-4 mx-auto max-w-2xl space-y-3 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <SectionTitle>Export my data · Memory Passport</SectionTitle>
      <p className="text-xs text-slate-500">
        Download <span className="font-medium">everything</span> Cogeto knows for you: every fact
        with its status, provenance and full history, your derived tasks, and your deletion receipts
        (still independently verifiable), in an open, documented, versioned format. Your memory is
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
            Attach the original bytes of files you uploaded (a full archive). Off by default.
            Provenance and metadata are always included either way.
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
          <span className="text-xs text-red-700 dark:text-red-300">
            Couldn’t start the export. Try again.
          </span>
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
                    ? 'text-red-700 dark:text-red-300'
                    : row.status === 'ready'
                      ? 'text-brand-teal-ink dark:text-brand-teal'
                      : 'text-slate-400'
                }`}
              >
                {PASSPORT_STATUS_LABEL[row.status]}
                {row.status === 'failed' && row.error ? `: ${row.error}` : ''}
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
        <span className="font-mono">docs/passport-schema/</span>. Anyone can read and verify a
        Passport with only the schema and the instance public key above.
      </p>
    </section>
  );
}

/** Plain words for a refusal reason (decision 0031; legacy reasons included). */
const REFUSAL_REASON_LABEL: Record<string, string> = {
  sender_not_recognized: 'sender is not a registered user and not on any allowlist',
  sender_not_allowlisted: 'sender was not on the allowlist',
  no_owner: 'no capture owner was configured (older refusal)',
  wrong_recipient: 'addressed to a different recipient',
  message_too_large: 'message exceeded the size cap',
  attachments_too_large: 'attachments exceeded the size cap',
};

/** Only sender-identity refusals are fixable by allowlisting (decision 0031). */
const CLAIMABLE_REASONS = new Set(['sender_not_recognized', 'sender_not_allowlisted', 'no_owner']);

/**
 * Email capture (Session O4, decision 0028; sender routing per decision 0031):
 * the instance's inbound address, the caller's always-trusted own address, the
 * personal allowlist that routes external senders to them, and recent refusals
 * with one-click claiming where allowlisting can actually help.
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
    <section className="mt-4 mx-auto max-w-2xl space-y-4 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>Email capture</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">
          Forward, BCC, or set a provider rule to send mail to the inbound address. Mail{' '}
          <strong>you</strong> send there (from your own address) is always captured for you; mail
          from other senders reaches you only when they are on <strong>your</strong> allowlist
          below. Captured email follows your default scope above.
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
                Not configured yet. The operator sets this when provisioning the instance.
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
                Cogeto only ever receives <strong>what you forward</strong>, never your whole
                mailbox, and never your password or account access.
              </p>
            </div>
          )}

          {config.data.selfAddress && (
            <div className="rounded-md bg-slate-50 p-3">
              <div className="text-xs font-medium text-slate-500">Always trusted</div>
              <p className="mt-1 text-sm text-slate-700">
                <span className="font-mono">{config.data.selfAddress}</span>
                <span className="ml-2 text-xs text-slate-400">
                  your registered address: anything you forward or BCC is captured for you
                </span>
              </p>
            </div>
          )}

          <div>
            <div className="text-sm font-medium text-slate-700">Allowed senders</div>
            <p className="text-xs text-slate-400">
              External senders whose mail becomes <strong>your</strong> memory, typically the people
              you auto-forward from your provider. Other users keep their own lists.
            </p>
            {allowlist.length === 0 ? (
              <p className="mt-1 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">
                No external senders allowed yet. Apart from your own address above, Cogeto is{' '}
                <strong>closed by default</strong> and accepts no mail for you until you add an
                address or domain here.
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
                      className="shrink-0 text-xs text-red-700 dark:text-red-300 hover:underline"
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
            <p className="text-xs text-red-700 dark:text-red-300">
              {add.error instanceof Error ? add.error.message : 'Couldn’t add. Check the value.'}
            </p>
          )}

          {refusals.length > 0 && (
            <div>
              <div className="text-sm font-medium text-slate-700">Recently refused</div>
              <p className="text-xs text-slate-400">
                Mail Cogeto turned away, and why. When the sender just isn’t known yet, claim them
                for your own capture in one click.
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
                        <span className="ml-2 text-xs text-slate-400">
                          {REFUSAL_REASON_LABEL[r.reason] ?? r.reason}
                        </span>
                      </span>
                      {CLAIMABLE_REASONS.has(r.reason) && (
                        <button
                          type="button"
                          onClick={() =>
                            r.fromAddr && add.mutate({ kind: 'address', value: r.fromAddr })
                          }
                          disabled={add.isPending}
                          className="shrink-0 text-xs text-brand-teal-ink dark:text-brand-teal hover:underline"
                        >
                          Allow this sender
                        </button>
                      )}
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
