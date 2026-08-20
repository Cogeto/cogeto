import { useEffect, useState } from 'react';
import { useConfirm } from '../components/confirm';
import type { ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import type { EmailAllowlistKind, MemoryScope } from '@cogeto/shared';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
import {
  addConnectorSubScope,
  addEmailAlias,
  addEmailAllowlistEntry,
  addEntityAlias,
  addExtractionGateRule,
  connectConfluence,
  disableConnector,
  enableConnector,
  fetchConnectorDetail,
  fetchConnectors,
  fetchEntityAliases,
  fetchEmailConfig,
  fetchExtractionGateConfig,
  fetchMe,
  fetchPassportDownload,
  fetchPassportExports,
  fetchSettings,
  fetchSpaces,
  fetchSpaceDeletionPlan,
  deleteSpace,
  putCurrentSpace,
  renameSpace,
  reconnectConfluence,
  removeConnector,
  removeEmailAlias,
  removeEmailAllowlistEntry,
  removeEntityAlias,
  removeExtractionGateRule,
  requestConfluenceEstimate,
  setExtractionGate,
  sweepConnectorPresence,
  fetchConnectorErasedItems,
  reingestConnectorItem,
  syncConnector,
  triggerPassportExport,
  updateConnectorSettings,
  updateConnectorSubScope,
  updateSettings,
  fetchProjects,
} from '../api';
import type { ConnectorDto, ConnectorSettingsDto, ConnectorState } from '../api';
import type { Session } from '../auth/oidc';
import { commitSpaceChange, currentSpaceId } from '../space';
import { formatDate } from '../i18n/format';
import { Shell } from '../components/Shell';
import {
  btnDanger,
  btnPrimary,
  btnSecondary,
  Drawer,
  ErrorState,
  Pill,
  SectionTitle,
  Skeleton,
  SkeletonRows,
  consequenceOf,
} from '../components/ui';
import { timeAgo } from '../components/status';
import type { Tone } from '../components/status';
import { useApiErrorMessage } from '../i18n/api-error';

/** Settings: only real, wired toggles — every control does something today. */
export function Settings({ session }: { session: Session }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => fetchSettings(session) });
  const spaceList = useQuery({ queryKey: ['spaces'], queryFn: () => fetchSpaces(session) });
  const spaceName = spaceList.data?.spaces.find((s) => s.id === currentSpaceId())?.name ?? '';

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
    <Shell session={session} title={t('spaces:settings.title')} active="settings">
      {/* The level, stated where the settings are shown (issue C4): everything
          on this page is space-scoped, per user, and the page names the space
          it governs. Identity, appearance and infrastructure live in the
          instance area. */}
      <p className="rounded-lg border border-slate-200 bg-slate-100/60 px-4 py-2.5 text-xs text-slate-500 dark:bg-white/5">
        {t('spaces:level.space', { space: spaceName })}
      </p>

      <ThisSpaceSection session={session} />

      <section className="space-y-5 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
        <div>
          <SectionTitle>{t('capture.heading')}</SectionTitle>
          <p className="mt-1 text-xs text-slate-400">{t('capture.explainer')}</p>
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
                <span className="font-medium">{t('capture.discard.label')}</span>
                <span className="block text-xs text-slate-400">{t('capture.discard.help')}</span>
              </span>
            </label>

            <label className="flex items-center gap-3 text-sm text-slate-700">
              <span className="font-medium">{t('capture.defaultScope')}</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as MemoryScope)}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
              >
                <option value="private">{t('common:memoryScope.private')}</option>
                <option value="shared">{t('common:memoryScope.shared')}</option>
              </select>
              <span className="text-xs text-slate-400">{t('capture.scopeHelp')}</span>
            </label>

            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={save.isPending}
                onClick={() => save.mutate()}
                className={btnPrimary}
              >
                {save.isPending ? t('common:state.saving') : t('common:action.save')}
              </button>
              {saved && (
                <span className="text-xs text-brand-teal-ink dark:text-brand-teal">
                  {t('common:state.saved')}
                </span>
              )}
              {save.isError && (
                <span className="text-xs text-red-700 dark:text-red-300">{t('saveFailed')}</span>
              )}
            </div>
          </>
        )}
      </section>

      <ResearchSection session={session} />

      <EmailCaptureSection session={session} />

      <ConnectionsSection session={session} />

      <ExtractionGateSection session={session} />

      <EntityAliasesSection session={session} />

      <PassportSection session={session} />
    </Shell>
  );
}

/**
 * This space (docs/features/spaces.md section 3): its name, its rename, and
 * for an administrator the one irreversible act, behind a confirmation that
 * states exactly what will be erased (the deletion-plan numbers from session
 * 2) and requires typing the space's name. The default space is never
 * deletable and the section says so instead of hiding the fact.
 */
function ThisSpaceSection({ session }: { session: Session }) {
  const { t } = useTranslation('spaces');
  const queryClient = useQueryClient();
  const errorMessage = useApiErrorMessage(t);
  const spaceList = useQuery({ queryKey: ['spaces'], queryFn: () => fetchSpaces(session) });
  const me = useQuery({ queryKey: ['me'], queryFn: () => fetchMe(session) });
  const current = spaceList.data?.spaces.find((s) => s.id === currentSpaceId()) ?? null;
  const isDefault = current?.id === DEFAULT_SPACE_ID;

  const [name, setName] = useState('');
  const [renameSaved, setRenameSaved] = useState(false);
  const [armed, setArmed] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  useEffect(() => {
    if (current) setName(current.name);
  }, [current?.id, current?.name]);

  const rename = useMutation({
    mutationFn: () => renameSpace(session, current!.id, name.trim()),
    onSuccess: async () => {
      setRenameSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['spaces'] });
      setTimeout(() => setRenameSaved(false), 2500);
    },
  });

  // The plan loads when the administrator arms the deletion, so the
  // confirmation always states the numbers as of NOW, not of page load.
  const plan = useQuery({
    queryKey: ['space-deletion-plan', current?.id],
    queryFn: () => fetchSpaceDeletionPlan(session, current!.id),
    enabled: armed && current != null && !isDefault,
  });

  const erase = useMutation({
    mutationFn: async () => {
      await deleteSpace(session, current!.id);
      // The erased space cannot stay the persisted last-used one; land on the
      // default space's dashboard, deliberately, with the same committed
      // mechanics as every space change (F8): cover, navigate, retry.
      await putCurrentSpace(session, DEFAULT_SPACE_ID).catch(() => undefined);
      commitSpaceChange('/', t('switcher.reloading'));
    },
  });

  if (!current) return null;
  const confirmMatches = confirmName.trim() === current.name;

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>{t('settings.heading')}</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">{t('settings.explainer')}</p>
      </div>

      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && name.trim() !== current.name) rename.mutate();
        }}
      >
        <label className="flex items-center gap-3 text-sm text-slate-700">
          <span className="font-medium">{t('settings.nameLabel')}</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-700"
          />
        </label>
        <button
          type="submit"
          disabled={rename.isPending || name.trim() === '' || name.trim() === current.name}
          className={btnSecondary}
        >
          {t('common:action.save')}
        </button>
        {renameSaved && (
          <span className="text-xs text-brand-teal-ink dark:text-brand-teal">
            {t('common:state.saved')}
          </span>
        )}
        {rename.isError && (
          <span className="text-xs text-red-700 dark:text-red-300">
            {errorMessage(rename.error, 'switcher.renameFailed')}
          </span>
        )}
      </form>

      {me.data?.isAdmin === true && (
        <div className="space-y-3 border-t border-slate-200 pt-4">
          <SectionTitle as="h3">{t('settings.dangerHeading')}</SectionTitle>
          {isDefault ? (
            <p className="text-xs text-slate-500">{t('settings.defaultUndeletable')}</p>
          ) : !armed ? (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">{t('settings.dangerExplainer')}</p>
              <button type="button" className={btnDanger} onClick={() => setArmed(true)}>
                {t('settings.deleteButton')}
              </button>
            </div>
          ) : (
            <div className="space-y-3 rounded-md border border-red-200 bg-red-50/50 p-4 dark:border-red-500/30 dark:bg-red-500/5">
              {plan.isPending && <SkeletonRows rows={2} />}
              {plan.isError && (
                <ErrorState onRetry={() => void plan.refetch()}>
                  {errorMessage(plan.error, 'settings.planFailed')}
                </ErrorState>
              )}
              {plan.data && (
                <>
                  <p className="text-sm font-medium text-slate-800">
                    {t('settings.planIntro', { space: current.name })}
                  </p>
                  {plan.data.totalSources === 0 && plan.data.containers.length === 0 ? (
                    <p className="text-sm text-slate-600">{t('settings.planEmpty')}</p>
                  ) : (
                    <ul className="list-inside list-disc space-y-0.5 text-sm text-slate-600">
                      {plan.data.sources.map((entry) => (
                        <li key={entry.sourceType}>
                          {t('settings.planLine', {
                            n: entry.count,
                            kind: t(`settings.sourceType.${entry.sourceType}`, {
                              defaultValue: entry.sourceType,
                            }),
                          })}
                        </li>
                      ))}
                      {plan.data.containers.map((entry) => (
                        <li key={entry.artifact}>
                          {t('settings.planLine', {
                            n: entry.count,
                            kind: t(`settings.artifact.${entry.artifact}`, {
                              defaultValue: entry.artifact,
                            }),
                          })}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-slate-500">{t('settings.planReceipts')}</p>
                  <label className="block text-sm text-slate-700">
                    <span className="font-medium">
                      {t('settings.confirmLabel', { space: current.name })}
                    </span>
                    <input
                      value={confirmName}
                      onChange={(event) => setConfirmName(event.target.value)}
                      placeholder={current.name}
                      className="mt-1 w-full max-w-sm rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      disabled={!confirmMatches || erase.isPending}
                      onClick={() => erase.mutate()}
                      className={btnDanger}
                    >
                      {erase.isPending
                        ? t('settings.deleting')
                        : t('settings.deleteConfirm', { space: current.name })}
                    </button>
                    <button
                      type="button"
                      className={btnSecondary}
                      onClick={() => {
                        setArmed(false);
                        setConfirmName('');
                      }}
                    >
                      {t('common:action.cancel')}
                    </button>
                    {erase.isError && (
                      <span className="text-xs text-red-700 dark:text-red-300">
                        {errorMessage(erase.error, 'settings.deleteFailed')}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Research: when on, a chat answer that would offer web research just runs it.
 * No tap, no gate, no picking. Off by default. Stored per user PER SPACE (the
 * settings split): research behaviour is content behaviour, so what auto-runs
 * in one space says nothing about another.
 */
function ResearchSection({ session }: { session: Session }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => fetchSettings(session) });
  const toggle = useMutation({
    mutationFn: (on: boolean) => updateSettings(session, { autoResearch: on }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });
  return (
    <section className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>{t('research.heading')}</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">{t('research.explainer')}</p>
      </div>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={settings.data?.autoResearch ?? false}
          disabled={settings.isPending || toggle.isPending}
          onChange={(e) => toggle.mutate(e.target.checked)}
          className="mt-1"
        />
        <span className="text-sm text-slate-700">
          <span className="font-medium">{t('research.auto.label')}</span>
          <span className="block text-xs text-slate-400">{t('research.auto.help')}</span>
        </span>
      </label>
      {toggle.isError && (
        <p className="text-xs text-red-700 dark:text-red-300">{t('saveFailed')}</p>
      )}
    </section>
  );
}

/**
 * Memory Passport (spec §11.4): a complete, documented, versioned
 * export of the user's own data — the anti-lock-in promise made real. Assembly
 * runs in the worker; this polls the request and hands back a short-lived signed
 * download. The artifact is an open format documented in docs/passport-schema/.
 */
function PassportSection({ session }: { session: Session }) {
  const { t } = useTranslation('passport');
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
    <section className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <SectionTitle>{t('heading')}</SectionTitle>
      <p className="text-xs text-slate-500">
        <Trans
          i18nKey="explainer"
          ns="passport"
          components={{ b: <span className="font-medium" /> }}
        />
      </p>

      <label className="flex items-start gap-3 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={includeOriginals}
          onChange={(e) => setIncludeOriginals(e.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="font-medium">{t('includeOriginals.label')}</span>
          <span className="block text-xs text-slate-400">{t('includeOriginals.help')}</span>
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={trigger.isPending || pending}
          onClick={() => trigger.mutate()}
          className={btnPrimary}
        >
          {trigger.isPending || pending ? t('preparing') : t('export')}
        </button>
        {trigger.isError && (
          <span className="text-xs text-red-700 dark:text-red-300">{t('startFailed')}</span>
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
                {t(`status.${row.status}`)}
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
                  {t('common:action.download')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-400">
        <Trans
          i18nKey="formatNote"
          ns="passport"
          components={{ path: <span className="font-mono" /> }}
        />
      </p>
    </section>
  );
}

/**
 * Refusal REASONS are server values (legacy ones included); only their plain
 * wording is translated, through `email:refusalReason.<value>`. An unknown
 * reason still renders its raw value, as before.
 */
const REFUSAL_REASONS = [
  'sender_not_recognized',
  'sender_not_allowlisted',
  'no_owner',
  'wrong_recipient',
  'message_too_large',
  'attachments_too_large',
  'alias_not_recognized',
];

/** Only sender-identity refusals are fixable by allowlisting. */
const CLAIMABLE_REASONS = new Set(['sender_not_recognized', 'sender_not_allowlisted', 'no_owner']);

/**
 * Email capture (sender routing per)
 * the instance's inbound address, the caller's always-trusted own address, the
 * personal allowlist that routes external senders to them, and recent refusals
 * with one-click claiming where allowlisting can actually help.
 */
function EmailCaptureSection({ session }: { session: Session }) {
  const { t } = useTranslation('email');
  const apiError = useApiErrorMessage(t);
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ['email-config'], queryFn: () => fetchEmailConfig(session) });
  // The routing targets (docs/features/spaces.md section 6c): every rule
  // names the space its mail lands in, chosen here, visibly.
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => fetchSpaces(session) });
  const spaceNameById = new Map((spaces.data?.spaces ?? []).map((s) => [s.id, s.name]));
  const boundSpace = currentSpaceId() ?? DEFAULT_SPACE_ID;

  const [kind, setKind] = useState<EmailAllowlistKind>('address');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [targetSpace, setTargetSpace] = useState<string | null>(null);
  const [aliasValue, setAliasValue] = useState('');
  const [aliasSpace, setAliasSpace] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['email-config'] });

  const add = useMutation({
    mutationFn: (entry: {
      kind: EmailAllowlistKind;
      value: string;
      note?: string | null;
      spaceId?: string;
    }) => addEmailAllowlistEntry(session, entry),
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
  const addAlias = useMutation({
    mutationFn: (request: { alias: string; spaceId: string }) => addEmailAlias(session, request),
    onSuccess: async () => {
      setAliasValue('');
      await invalidate();
    },
  });
  const removeAlias = useMutation({
    mutationFn: (id: string) => removeEmailAlias(session, id),
    onSuccess: invalidate,
  });

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed)
      add.mutate({
        kind,
        value: trimmed,
        note: note.trim() || null,
        spaceId: targetSpace ?? boundSpace,
      });
  };
  const submitAlias = () => {
    const trimmed = aliasValue.trim();
    if (trimmed) addAlias.mutate({ alias: trimmed, spaceId: aliasSpace ?? boundSpace });
  };

  const allowlist = config.data?.allowlist ?? [];
  const aliases = config.data?.aliases ?? [];
  const refusals = config.data?.recentRefusals ?? [];
  // Senders already listed shouldn't be offered as one-click adds.
  const listed = new Set(allowlist.map((e) => e.value));
  const spaceLabel = (id: string) => spaceNameById.get(id) ?? id;
  const aliasAddressFor = (alias: string) => {
    const inbound = config.data?.inboundAddress ?? '';
    const at = inbound.indexOf('@');
    return at > 0 ? `${inbound.slice(0, at)}+${alias}${inbound.slice(at)}` : alias;
  };

  return (
    <section className="mt-4 space-y-4 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>{t('heading')}</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">
          <Trans i18nKey="explainer" ns="email" components={{ b: <strong /> }} />
        </p>
        {/* The routing rule, stated where it is configured
            (docs/features/spaces.md section 6c): every rule names its target
            space, and mail matching no rule lands in the default space. */}
        <p className="mt-1.5 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
          {t('routingNote', { defaultSpace: spaceLabel(DEFAULT_SPACE_ID) })}
        </p>
      </div>

      {config.isPending && <Skeleton className="h-24 w-full" />}

      {config.data && (
        <>
          <div className="rounded-md bg-slate-50 p-3">
            <div className="text-xs font-medium text-slate-500">{t('inboundAddress')}</div>
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
                  {copied ? t('common:action.copied') : t('common:action.copy')}
                </button>
              </div>
            ) : (
              <p className="mt-1 text-xs text-slate-400">{t('notConfigured')}</p>
            )}
          </div>

          {config.data.inboundAddress && (
            <div className="space-y-2 text-xs text-slate-500">
              <div className="font-medium text-slate-700">{t('howTo.heading')}</div>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <Trans
                    i18nKey="howTo.forward"
                    ns="email"
                    components={{ b: <span className="font-medium text-slate-600" /> }}
                  />
                </li>
                <li>
                  <Trans
                    i18nKey="howTo.bcc"
                    ns="email"
                    components={{ b: <span className="font-medium text-slate-600" /> }}
                  />
                </li>
                <li>
                  <Trans
                    i18nKey="howTo.autoForward"
                    ns="email"
                    components={{
                      b: <span className="font-medium text-slate-600" />,
                      note: <span className="text-slate-400" />,
                    }}
                  />
                </li>
              </ul>
              <p className="rounded-md bg-slate-50 p-2 text-slate-500">
                <Trans
                  i18nKey="howTo.onlyWhatYouForward"
                  ns="email"
                  components={{ b: <strong /> }}
                />
              </p>
            </div>
          )}

          {config.data.selfAddress && (
            <div className="rounded-md bg-slate-50 p-3">
              <div className="text-xs font-medium text-slate-500">{t('alwaysTrusted')}</div>
              <p className="mt-1 text-sm text-slate-700">
                <span className="font-mono">{config.data.selfAddress}</span>
                <span className="ml-2 text-xs text-slate-400">{t('selfAddressNote')}</span>
              </p>
            </div>
          )}

          <div>
            <div className="text-sm font-medium text-slate-700">{t('allowlist.heading')}</div>
            <p className="text-xs text-slate-400">
              <Trans i18nKey="allowlist.explainer" ns="email" components={{ b: <strong /> }} />
            </p>
            {allowlist.length === 0 ? (
              <p className="mt-1 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">
                <Trans i18nKey="allowlist.empty" ns="email" components={{ b: <strong /> }} />
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
                {allowlist.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0 text-sm text-slate-700">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                        {entry.kind}
                      </span>{' '}
                      <span className="font-mono">{entry.value}</span>{' '}
                      <span
                        className="rounded bg-brand-teal/10 px-1.5 py-0.5 text-xs text-brand-teal-ink dark:text-brand-teal"
                        title={t('allowlist.spaceTargetTitle')}
                      >
                        {t('allowlist.spaceTarget', { space: spaceLabel(entry.spaceId) })}
                      </span>
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
                      {t('common:action.remove')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-500">
              <span className="block">{t('allowlist.kind')}</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as EmailAllowlistKind)}
                className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
              >
                <option value="address">{t('allowlist.kindValue.address')}</option>
                <option value="domain">{t('allowlist.kindValue.domain')}</option>
              </select>
            </label>
            <label className="min-w-[16rem] flex-1 text-xs text-slate-500">
              <span className="block">
                {kind === 'address' ? t('allowlist.addressField') : t('allowlist.domainField')}
              </span>
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder={
                  kind === 'address'
                    ? t('allowlist.addressPlaceholder')
                    : t('allowlist.domainPlaceholder')
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="min-w-[10rem] flex-1 text-xs text-slate-500">
              <span className="block">{t('allowlist.note')}</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder={t('allowlist.notePlaceholder')}
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-slate-500">
              <span className="block">{t('allowlist.spaceField')}</span>
              <select
                value={targetSpace ?? boundSpace}
                onChange={(e) => setTargetSpace(e.target.value)}
                className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
              >
                {(spaces.data?.spaces ?? []).map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={submit}
              disabled={add.isPending || !value.trim()}
              className={btnPrimary}
            >
              {t('common:action.add')}
            </button>
          </div>
          {add.isError && (
            <p className="text-xs text-red-700 dark:text-red-300">
              {apiError(add.error, 'allowlist.addFailed')}
            </p>
          )}

          <div>
            <div className="text-sm font-medium text-slate-700">{t('aliases.heading')}</div>
            <p className="text-xs text-slate-400">
              {t('aliases.explainer', {
                example: aliasAddressFor(t('aliases.exampleAlias')),
              })}
            </p>
            {aliases.length > 0 && (
              <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
                {aliases.map((alias) => (
                  <li key={alias.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0 text-sm text-slate-700">
                      <span className="font-mono">{aliasAddressFor(alias.alias)}</span>{' '}
                      <span className="rounded bg-brand-teal/10 px-1.5 py-0.5 text-xs text-brand-teal-ink dark:text-brand-teal">
                        {t('allowlist.spaceTarget', { space: spaceLabel(alias.spaceId) })}
                      </span>
                      {alias.note && (
                        <span className="block truncate text-xs text-slate-400">{alias.note}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAlias.mutate(alias.id)}
                      disabled={removeAlias.isPending}
                      className="shrink-0 text-xs text-red-700 dark:text-red-300 hover:underline"
                    >
                      {t('common:action.remove')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="min-w-[12rem] flex-1 text-xs text-slate-500">
                <span className="block">{t('aliases.aliasField')}</span>
                <input
                  value={aliasValue}
                  onChange={(e) => setAliasValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitAlias()}
                  placeholder={t('aliases.aliasPlaceholder')}
                  className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="text-xs text-slate-500">
                <span className="block">{t('allowlist.spaceField')}</span>
                <select
                  value={aliasSpace ?? boundSpace}
                  onChange={(e) => setAliasSpace(e.target.value)}
                  className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                >
                  {(spaces.data?.spaces ?? []).map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={submitAlias}
                disabled={addAlias.isPending || !aliasValue.trim()}
                className={btnPrimary}
              >
                {t('common:action.add')}
              </button>
            </div>
            {addAlias.isError && (
              <p className="mt-1 text-xs text-red-700 dark:text-red-300">
                {apiError(addAlias.error, 'aliases.addFailed')}
              </p>
            )}
            <p className="mt-1.5 text-xs text-slate-400">{t('aliases.refuseNote')}</p>
          </div>

          {refusals.length > 0 && (
            <div>
              <div className="text-sm font-medium text-slate-700">{t('refusals.heading')}</div>
              <p className="text-xs text-slate-400">{t('refusals.explainer')}</p>
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
                          {REFUSAL_REASONS.includes(r.reason)
                            ? t(`refusalReason.${r.reason}`)
                            : r.reason}
                        </span>
                      </span>
                      {CLAIMABLE_REASONS.has(r.reason) && (
                        <button
                          type="button"
                          onClick={() =>
                            r.fromAddr &&
                            add.mutate({ kind: 'address', value: r.fromAddr, spaceId: boundSpace })
                          }
                          disabled={add.isPending}
                          className="shrink-0 text-xs text-brand-teal-ink dark:text-brand-teal hover:underline"
                        >
                          {t('refusals.allowSender')}
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

/**
 * The connector STATE, its paused reason and a run's vocabulary are API values
 * (V2.5 items 8.1 and 8.2); only their display names are translated, through
 * explicit value → key maps. An unknown value renders verbatim.
 */
const CONNECTOR_STATE_KEY: Record<string, string> = {
  configured: 'state.configured',
  authorised: 'state.authorised',
  syncing: 'state.syncing',
  healthy: 'state.healthy',
  degraded: 'state.degraded',
  needs_reauth: 'state.needs_reauth',
  disabled: 'state.disabled',
  removed: 'state.removed',
};

const CONNECTOR_STATE_TONE: Record<string, Tone> = {
  configured: 'neutral',
  authorised: 'info',
  syncing: 'info',
  healthy: 'positive',
  degraded: 'warning',
  needs_reauth: 'danger',
  disabled: 'neutral',
  removed: 'neutral',
};

const CONNECTOR_PAUSED_REASON_KEY: Record<string, string> = {
  rate_limited: 'pausedReason.rate_limited',
  daily_item_cap: 'pausedReason.daily_item_cap',
  daily_upload_limit: 'pausedReason.daily_upload_limit',
};

const CONFLUENCE_CONNECT_FAILURE_KEY: Record<string, string> = {
  wrong_site: 'connect.failure.wrong_site',
  bad_credentials: 'connect.failure.bad_credentials',
  no_permission: 'connect.failure.no_permission',
  unreachable: 'connect.failure.unreachable',
};

const SYNC_RUN_KIND_KEY: Record<string, string> = {
  backfill: 'detail.runs.kind.backfill',
  incremental: 'detail.runs.kind.incremental',
  webhook: 'detail.runs.kind.webhook',
  presence: 'detail.runs.kind.presence',
};

const SYNC_RUN_STATE_KEY: Record<string, string> = {
  running: 'detail.runs.state.running',
  completed: 'detail.runs.state.completed',
  failed: 'detail.runs.state.failed',
  cancelled: 'detail.runs.state.cancelled',
};

const runTone = (state: string): Tone =>
  state === 'completed'
    ? 'positive'
    : state === 'failed'
      ? 'danger'
      : state === 'running'
        ? 'info'
        : 'neutral';

/** The lifecycle states in which sync, estimate and presence make sense. */
const SYNCABLE_CONNECTOR_STATES: ConnectorState[] = [
  'authorised',
  'syncing',
  'healthy',
  'degraded',
];

/**
 * Connections (V2.5 item 8.2): the connector fleet's surface. The list shows
 * every connector with its honest state (a connector that silently stopped
 * syncing reads degraded or needs reauthorisation, never merely quiet); the
 * Confluence connect form states the read-only promise at the moment the
 * token is handed over; the detail drawer holds scopes, backfill, runs.
 */
function ConnectionsSection({ session }: { session: Session }) {
  const confirm = useConfirm();
  const { t } = useTranslation('connections');
  const apiError = useApiErrorMessage(t);
  const queryClient = useQueryClient();
  const connectors = useQuery({
    queryKey: ['connectors'],
    queryFn: () => fetchConnectors(session),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['connectors'] });

  const [showConnect, setShowConnect] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncQueuedId, setSyncQueuedId] = useState<string | null>(null);

  const onActionError = (error: unknown) => setActionError(apiError(error, 'list.actionFailed'));
  const sync = useMutation({
    mutationFn: (id: string) => syncConnector(session, id),
    onSuccess: async (_result, id) => {
      setActionError(null);
      setSyncQueuedId(id);
      await invalidate();
    },
    onError: onActionError,
  });
  const disable = useMutation({
    mutationFn: (id: string) => disableConnector(session, id),
    onSuccess: async () => {
      setActionError(null);
      await invalidate();
    },
    onError: onActionError,
  });
  const enable = useMutation({
    mutationFn: (id: string) => enableConnector(session, id),
    onSuccess: async () => {
      setActionError(null);
      await invalidate();
    },
    onError: onActionError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeConnector(session, id),
    onSuccess: async () => {
      setActionError(null);
      setOpenId(null);
      await invalidate();
    },
    onError: onActionError,
  });

  // The consequence copy is explicit: ingested sources REMAIN (V2.5 item 8.1's
  // removal rule); only the credential and the sync state are destroyed.
  const confirmRemove = (row: ConnectorDto) => {
    void confirm({
      title: t('list.removeQuestion', { name: row.name }),
      consequence: consequenceOf(t('list.removeConfirm', { name: row.name })),
      confirmLabel: t('list.remove'),
      destructive: true,
    }).then((asked) => {
      if (asked) remove.mutate(row.id);
    });
  };

  const rows = (connectors.data ?? []).filter((row) => row.state !== 'removed');

  return (
    <section className="mt-4 space-y-4 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>{t('heading')}</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">{t('explainer')}</p>
        {/* A connector belongs to ONE space, chosen at connect time and
            immutable (docs/features/spaces.md section 6c): everything it
            ingests lands here, and this page lists this space's connectors
            only. The credential is authorised once, instance-level; the
            ingestion is sealed per space. */}
        <p className="mt-1.5 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
          {t('spaceNote')}
        </p>
      </div>

      {connectors.isPending && <Skeleton className="h-16 w-full" />}
      {connectors.isError && <ErrorState>{t('list.error')}</ErrorState>}

      {connectors.data && (
        <>
          {rows.length === 0 ? (
            <p className="text-xs text-slate-400">{t('list.empty')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
              {rows.map((row) => (
                <li key={row.id} className="space-y-1 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">
                      {row.name}
                    </span>
                    <Pill tone={CONNECTOR_STATE_TONE[row.state] ?? 'neutral'}>
                      {CONNECTOR_STATE_KEY[row.state]
                        ? t(CONNECTOR_STATE_KEY[row.state]!)
                        : row.state}
                    </Pill>
                    <span className="text-xs text-slate-400" title={row.lastSyncAt ?? undefined}>
                      {row.lastSyncAt
                        ? t('list.lastSync', { when: timeAgo(row.lastSyncAt) })
                        : t('list.neverSynced')}
                    </span>
                  </div>
                  {row.settings.pausedReason && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      {CONNECTOR_PAUSED_REASON_KEY[row.settings.pausedReason]
                        ? t(CONNECTOR_PAUSED_REASON_KEY[row.settings.pausedReason]!)
                        : row.settings.pausedReason}
                    </p>
                  )}
                  {row.statusReason && <p className="text-xs text-slate-500">{row.statusReason}</p>}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={btnSecondary}
                      onClick={() => setOpenId(row.id)}
                    >
                      {t('list.open')}
                    </button>
                    <button
                      type="button"
                      className={btnSecondary}
                      disabled={sync.isPending || !SYNCABLE_CONNECTOR_STATES.includes(row.state)}
                      onClick={() => sync.mutate(row.id)}
                    >
                      {t('list.sync')}
                    </button>
                    {row.state === 'disabled' ? (
                      <button
                        type="button"
                        className={btnSecondary}
                        disabled={enable.isPending}
                        onClick={() => enable.mutate(row.id)}
                      >
                        {t('list.enable')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={btnSecondary}
                        disabled={disable.isPending || row.state === 'configured'}
                        onClick={() => disable.mutate(row.id)}
                      >
                        {t('list.disable')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-xs text-red-700 dark:text-red-300 hover:underline"
                      disabled={remove.isPending}
                      onClick={() => confirmRemove(row)}
                    >
                      {t('common:action.remove')}
                    </button>
                    {syncQueuedId === row.id && (
                      <span className="text-xs text-slate-400">{t('list.syncQueued')}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {actionError && <p className="text-xs text-red-700 dark:text-red-300">{actionError}</p>}

          <div>
            <button
              type="button"
              onClick={() => setShowConnect((value) => !value)}
              className={btnPrimary}
            >
              {showConnect ? t('common:action.cancel') : t('connect.open')}
            </button>
          </div>
          {showConnect && <ConfluenceConnectForm session={session} onConnected={invalidate} />}
        </>
      )}

      {openId && (
        <ConnectorDetailDrawer session={session} id={openId} onClose={() => setOpenId(null)} />
      )}
    </section>
  );
}

/**
 * The Confluence connect form (V2.5 item 8.2, issue A). The read-only
 * statement is shown AT THE MOMENT of connecting, because an Atlassian API
 * token carries its account's full permissions: the promise and the stronger
 * arrangement both belong next to the token field, not in a manual.
 */
function ConfluenceConnectForm({
  session,
  onConnected,
}: {
  session: Session;
  onConnected: () => Promise<unknown>;
}) {
  const { t } = useTranslation('connections');
  const apiError = useApiErrorMessage(t);
  const [name, setName] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [spacesVisible, setSpacesVisible] = useState<number | null>(null);

  const connect = useMutation({
    mutationFn: () =>
      connectConfluence(session, {
        name: name.trim(),
        siteUrl: siteUrl.trim(),
        email: email.trim(),
        apiToken: apiToken.trim(),
      }),
    onSuccess: async (result) => {
      if (!result.connected) {
        setFailure(result.reason);
        setSpacesVisible(null);
        return;
      }
      setFailure(null);
      setSpacesVisible(result.spacesVisible);
      setName('');
      setSiteUrl('');
      setEmail('');
      setApiToken('');
      await onConnected();
    },
  });

  const ready =
    name.trim() !== '' && siteUrl.trim() !== '' && email.trim() !== '' && apiToken.trim() !== '';
  const inputClass = 'mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm';

  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3">
      <div className="space-y-1 rounded-md border border-brand-teal/40 bg-brand-teal/5 p-3 text-xs text-slate-600">
        <p className="font-medium">{t('connect.readOnly.statement')}</p>
        <p>{t('connect.readOnly.recommendation')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-slate-500">
          <span className="block">{t('connect.name')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('connect.namePlaceholder')}
            className={inputClass}
            maxLength={200}
          />
        </label>
        <label className="block text-xs text-slate-500">
          <span className="block">{t('connect.siteUrl')}</span>
          <input
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder={t('connect.siteUrlPlaceholder')}
            className={inputClass}
            maxLength={500}
          />
        </label>
        <label className="block text-xs text-slate-500">
          <span className="block">{t('connect.email')}</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
            maxLength={320}
          />
        </label>
        <label className="block text-xs text-slate-500">
          <span className="block">{t('connect.apiToken')}</span>
          <input
            type="password"
            autoComplete="off"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>
      <p className="text-xs text-slate-400">{t('connect.apiTokenHelp')}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={connect.isPending || !ready}
          onClick={() => connect.mutate()}
          className={btnPrimary}
        >
          {connect.isPending ? t('connect.connecting') : t('connect.action')}
        </button>
        {spacesVisible !== null && (
          <span className="text-xs text-brand-teal-ink dark:text-brand-teal">
            {t('connect.success', { count: spacesVisible })}
          </span>
        )}
      </div>
      {failure && (
        <p className="text-xs text-red-700 dark:text-red-300">
          {CONFLUENCE_CONNECT_FAILURE_KEY[failure]
            ? t(CONFLUENCE_CONNECT_FAILURE_KEY[failure]!)
            : failure}
        </p>
      )}
      {connect.isError && (
        <p className="text-xs text-red-700 dark:text-red-300">
          {apiError(connect.error, 'connect.failed')}
        </p>
      )}
    </div>
  );
}

/**
 * One connector's detail: account, state, scopes with the honest estimate,
 * backfill bounds, recent runs, the presence check. Polls only while a sync
 * runs or an estimate is pending, the passport list's modest pattern.
 */
function ConnectorDetailDrawer({
  session,
  id,
  onClose,
}: {
  session: Session;
  id: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('connections');
  const apiError = useApiErrorMessage(t);
  const { t: tp } = useTranslation('projects');
  const queryClient = useQueryClient();
  const [estimateAt, setEstimateAt] = useState<number | null>(null);
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => fetchProjects(session, { archived: false }),
  });
  const detail = useQuery({
    queryKey: ['connector', id],
    queryFn: () => fetchConnectorDetail(session, id),
    refetchInterval: (query) =>
      query.state.data?.state === 'syncing' || estimateAt !== null ? 3000 : false,
  });

  // Stop the estimate poll once fresh stats landed, or give up after 90s.
  useEffect(() => {
    if (estimateAt === null || !detail.data) return;
    const landed = detail.data.subScopes.some(
      (scope) => scope.stats && Date.parse(scope.stats.computedAt) >= estimateAt,
    );
    if (landed || Date.now() - estimateAt > 90_000) setEstimateAt(null);
  }, [detail.data, estimateAt]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['connector', id] });
    await queryClient.invalidateQueries({ queryKey: ['connectors'] });
  };

  const estimate = useMutation({
    mutationFn: () => requestConfluenceEstimate(session, id),
    onSuccess: () => setEstimateAt(Date.now()),
  });
  const setScope = useMutation({
    mutationFn: (input: {
      key: string;
      patch: { selected?: boolean; attachments?: boolean; projectId?: string | null };
    }) => updateConnectorSubScope(session, id, input.key, input.patch),
    onSuccess: invalidate,
  });
  const [presenceQueued, setPresenceQueued] = useState(false);
  const presence = useMutation({
    mutationFn: () => sweepConnectorPresence(session, id),
    onSuccess: () => setPresenceQueued(true),
  });

  const data = detail.data;
  const syncable = data ? SYNCABLE_CONNECTOR_STATES.includes(data.state) : false;

  return (
    <Drawer title={t('detail.title')} onClose={onClose}>
      {detail.isPending && <SkeletonRows rows={4} label={t('detail.loading')} />}
      {detail.isError && <ErrorState>{t('detail.error')}</ErrorState>}
      {data && (
        <>
          <div className="space-y-1 rounded-md bg-slate-50 p-3">
            <p className="text-sm font-medium text-slate-800">{data.name}</p>
            {data.credential?.accountIdentity && (
              <p className="text-xs text-slate-500">
                <span className="font-medium">{t('detail.account')}</span>{' '}
                <span className="font-mono">{data.credential.accountIdentity}</span>
              </p>
            )}
            <p className="flex flex-wrap items-center gap-2 text-xs">
              <Pill tone={CONNECTOR_STATE_TONE[data.state] ?? 'neutral'}>
                {CONNECTOR_STATE_KEY[data.state] ? t(CONNECTOR_STATE_KEY[data.state]!) : data.state}
              </Pill>
              <span className="text-slate-400" title={data.lastSyncAt ?? undefined}>
                {data.lastSyncAt
                  ? t('list.lastSync', { when: timeAgo(data.lastSyncAt) })
                  : t('list.neverSynced')}
              </span>
            </p>
            {data.statusReason && <p className="text-xs text-slate-500">{data.statusReason}</p>}
            {data.settings.pausedReason && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {CONNECTOR_PAUSED_REASON_KEY[data.settings.pausedReason]
                  ? t(CONNECTOR_PAUSED_REASON_KEY[data.settings.pausedReason]!)
                  : data.settings.pausedReason}
              </p>
            )}
          </div>

          {data.state === 'needs_reauth' && data.kind === 'confluence' && (
            <ConfluenceReconnectForm session={session} id={id} onReconnected={invalidate} />
          )}

          <div>
            <p className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-slate-700">
                {t('detail.spaces.heading')}
              </span>
              {data.kind === 'confluence' && (
                <button
                  type="button"
                  className={btnSecondary}
                  disabled={estimate.isPending || estimateAt !== null || !syncable}
                  onClick={() => estimate.mutate()}
                >
                  {estimateAt !== null
                    ? t('detail.spaces.estimating')
                    : t('detail.spaces.estimateAction')}
                </button>
              )}
            </p>
            <p className="text-xs text-slate-400">{t('detail.spaces.explainer')}</p>
            {estimate.isError && (
              <p className="text-xs text-red-700 dark:text-red-300">
                {apiError(estimate.error, 'list.actionFailed')}
              </p>
            )}
            {data.subScopes.length === 0 ? (
              <p className="mt-1 text-xs text-slate-400">{t('detail.spaces.empty')}</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
                {data.subScopes.map((scope) => (
                  <li key={scope.key} className="space-y-1 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={scope.selected}
                          disabled={setScope.isPending}
                          onChange={(e) =>
                            setScope.mutate({
                              key: scope.key,
                              patch: { selected: e.target.checked },
                            })
                          }
                          className="rounded border-slate-300"
                        />
                        <span className="min-w-0 truncate">{scope.label}</span>
                      </label>
                      {scope.backfillComplete && (
                        <span className="text-xs text-slate-400">
                          {t('detail.spaces.backfillDone')}
                        </span>
                      )}
                    </div>
                    <label className="ml-6 flex items-center gap-2 text-xs text-slate-500">
                      <input
                        type="checkbox"
                        checked={scope.attachments}
                        disabled={setScope.isPending}
                        onChange={(e) =>
                          setScope.mutate({
                            key: scope.key,
                            patch: { attachments: e.target.checked },
                          })
                        }
                        className="rounded border-slate-300"
                      />
                      {t('detail.spaces.attachments')}
                    </label>
                    {/* A space assigned to a project puts everything it
                        ingests there automatically (V2.5 item 8.3 issue C1).
                        Applies to what it ingests NEXT; what it already
                        ingested keeps the project it was recorded under. */}
                    {(projects.data ?? []).length > 0 && (
                      <label className="ml-6 flex items-center gap-2 text-xs text-slate-500">
                        {tp('assign.scopeLabel')}
                        <select
                          value={scope.projectId ?? ''}
                          disabled={setScope.isPending}
                          onChange={(e) =>
                            setScope.mutate({
                              key: scope.key,
                              patch: { projectId: e.target.value || null },
                            })
                          }
                          className="rounded border border-slate-300 bg-surface px-1.5 py-0.5 text-xs"
                        >
                          <option value="">{tp('assign.none')}</option>
                          {(projects.data ?? []).map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {scope.stats && (
                      <p className="ml-6 text-xs text-slate-400">
                        {t('detail.spaces.about', { count: scope.stats.estimatedItems })}
                        {' · '}
                        {scope.stats.window === 'all'
                          ? t('detail.spaces.windowAll')
                          : t('detail.spaces.windowSince', {
                              date: formatDate(scope.stats.window),
                            })}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {data.kind === 'confluence' && (
            <ConfluenceSubtreeForm session={session} id={id} onAdded={invalidate} />
          )}

          <ConnectorBackfillSettings
            session={session}
            id={id}
            settings={data.settings}
            onSaved={invalidate}
          />

          <div>
            <p className="text-sm font-medium text-slate-700">{t('detail.runs.heading')}</p>
            {data.syncRuns.length === 0 ? (
              <p className="mt-1 text-xs text-slate-400">{t('detail.runs.empty')}</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
                {data.syncRuns.map((run) => (
                  <li key={run.id} className="space-y-0.5 px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-600">
                        {SYNC_RUN_KIND_KEY[run.kind] ? t(SYNC_RUN_KIND_KEY[run.kind]!) : run.kind}
                      </span>
                      <Pill tone={runTone(run.state)}>
                        {SYNC_RUN_STATE_KEY[run.state]
                          ? t(SYNC_RUN_STATE_KEY[run.state]!)
                          : run.state}
                      </Pill>
                      <span className="text-slate-400" title={run.startedAt}>
                        {timeAgo(run.startedAt)}
                      </span>
                    </div>
                    {run.reason && (
                      <p className="text-slate-500">
                        {CONNECTOR_PAUSED_REASON_KEY[run.reason]
                          ? t(CONNECTOR_PAUSED_REASON_KEY[run.reason]!)
                          : run.reason}
                      </p>
                    )}
                    {run.counts && (
                      <p className="flex flex-wrap gap-x-3 text-slate-500">
                        <span>
                          {t('detail.runs.count.materialized', { value: run.counts.materialized })}
                        </span>
                        <span>
                          {t('detail.runs.count.unchangedSkipped', {
                            value: run.counts.unchangedSkipped,
                          })}
                        </span>
                        <span>
                          {t('detail.runs.count.revisions', { value: run.counts.revisions })}
                        </span>
                        <span>
                          {t('detail.runs.count.deletedUpstream', {
                            value: run.counts.deletedUpstream,
                          })}
                        </span>
                        <span>
                          {t('detail.runs.count.skippedRestricted', {
                            value: run.counts.skippedRestricted,
                          })}
                        </span>
                        <span>{t('detail.runs.count.failed', { value: run.counts.failed })}</span>
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-1 border-t border-slate-100 pt-3">
            <p className="text-xs text-slate-500">{t('detail.presence.explainer')}</p>
            <button
              type="button"
              className={btnSecondary}
              disabled={presence.isPending || presenceQueued || !syncable}
              onClick={() => presence.mutate()}
            >
              {t('detail.presence.action')}
            </button>
            {presenceQueued && (
              <p className="text-xs text-slate-400">{t('detail.presence.queued')}</p>
            )}
            {presence.isError && (
              <p className="text-xs text-red-700 dark:text-red-300">
                {apiError(presence.error, 'list.actionFailed')}
              </p>
            )}
          </div>

          <ErasedItemsBlock session={session} id={id} syncable={syncable} />
        </>
      )}
    </Drawer>
  );
}

/**
 * The "deleted by you" list (issue #518): items whose sources the user
 * erased, which a sync will never bring back on its own. The ledger stores
 * identifiers and dates only, so that is what there honestly is to show;
 * the per-item action is the one audited path back, and the item returns as
 * a brand-new source through the normal pipeline.
 */
function ErasedItemsBlock({
  session,
  id,
  syncable,
}: {
  session: Session;
  id: string;
  syncable: boolean;
}) {
  const { t } = useTranslation('connections');
  const apiError = useApiErrorMessage(t);
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const erased = useQuery({
    queryKey: ['connector-erased', id],
    queryFn: () => fetchConnectorErasedItems(session, id),
  });
  const reingest = useMutation({
    mutationFn: (naturalKey: string) => reingestConnectorItem(session, id, naturalKey),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['connector-erased', id] });
      await queryClient.invalidateQueries({ queryKey: ['connector', id] });
    },
  });

  if (erased.isPending || erased.isError) return null;
  if (erased.data.items.length === 0) return null;
  return (
    <div className="space-y-2 border-t border-slate-100 pt-3">
      <p className="text-sm font-medium text-slate-800">{t('detail.erased.title')}</p>
      <p className="text-xs text-slate-500">{t('detail.erased.explainer')}</p>
      <ul className="space-y-1">
        {erased.data.items.map((item) => (
          <li key={item.naturalKey} className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate font-mono text-slate-600" title={item.naturalKey}>
              {item.naturalKey}
            </span>
            <span className="shrink-0 text-slate-400">
              {t('detail.erased.when', { when: timeAgo(item.erasedAt) })}
            </span>
            <button
              type="button"
              className={btnSecondary}
              disabled={reingest.isPending || !syncable}
              onClick={() => {
                void confirm({
                  title: t('detail.erased.question'),
                  consequence: t('detail.erased.confirm'),
                  confirmLabel: t('detail.erased.action'),
                }).then((asked) => {
                  if (asked) reingest.mutate(item.naturalKey);
                });
              }}
            >
              {t('detail.erased.action')}
            </button>
          </li>
        ))}
      </ul>
      {reingest.isError && (
        <p className="text-xs text-red-700 dark:text-red-300">
          {apiError(reingest.error, 'list.actionFailed')}
        </p>
      )}
    </div>
  );
}

/** Reconnect after needs_reauth: same validation, same one-way storage. */
function ConfluenceReconnectForm({
  session,
  id,
  onReconnected,
}: {
  session: Session;
  id: string;
  onReconnected: () => Promise<unknown>;
}) {
  const { t } = useTranslation('connections');
  const apiError = useApiErrorMessage(t);
  const [siteUrl, setSiteUrl] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const reconnect = useMutation({
    mutationFn: () =>
      reconnectConfluence(session, id, {
        siteUrl: siteUrl.trim(),
        email: email.trim(),
        apiToken: apiToken.trim(),
      }),
    onSuccess: async (result) => {
      if (!result.connected) {
        setFailure(result.reason);
        return;
      }
      setFailure(null);
      setDone(true);
      setApiToken('');
      await onReconnected();
    },
  });

  const ready = siteUrl.trim() !== '' && email.trim() !== '' && apiToken.trim() !== '';
  const inputClass = 'mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm';

  return (
    <div className="space-y-2 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3">
      <p className="text-xs text-amber-800 dark:text-amber-300">
        {t('detail.reconnect.explainer')}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-slate-500">
          <span className="block">{t('connect.siteUrl')}</span>
          <input
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder={t('connect.siteUrlPlaceholder')}
            className={inputClass}
            maxLength={500}
          />
        </label>
        <label className="block text-xs text-slate-500">
          <span className="block">{t('connect.email')}</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
            maxLength={320}
          />
        </label>
        <label className="block text-xs text-slate-500 sm:col-span-2">
          <span className="block">{t('connect.apiToken')}</span>
          <input
            type="password"
            autoComplete="off"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={reconnect.isPending || !ready}
          onClick={() => reconnect.mutate()}
          className={btnPrimary}
        >
          {reconnect.isPending ? t('detail.reconnect.connecting') : t('detail.reconnect.action')}
        </button>
        {done && (
          <span className="text-xs text-brand-teal-ink dark:text-brand-teal">
            {t('detail.reconnect.success')}
          </span>
        )}
      </div>
      {failure && (
        <p className="text-xs text-red-700 dark:text-red-300">
          {CONFLUENCE_CONNECT_FAILURE_KEY[failure]
            ? t(CONFLUENCE_CONNECT_FAILURE_KEY[failure]!)
            : failure}
        </p>
      )}
      {reconnect.isError && (
        <p className="text-xs text-red-700 dark:text-red-300">
          {apiError(reconnect.error, 'connect.failed')}
        </p>
      )}
    </div>
  );
}

/** A page and its descendants as a custom sub-scope (key form `page:{id}`). */
function ConfluenceSubtreeForm({
  session,
  id,
  onAdded,
}: {
  session: Session;
  id: string;
  onAdded: () => Promise<unknown>;
}) {
  const { t } = useTranslation('connections');
  const apiError = useApiErrorMessage(t);
  const [pageId, setPageId] = useState('');
  const [label, setLabel] = useState('');
  const [added, setAdded] = useState(false);

  const add = useMutation({
    mutationFn: () =>
      addConnectorSubScope(session, id, { key: `page:${pageId.trim()}`, label: label.trim() }),
    onSuccess: async () => {
      setPageId('');
      setLabel('');
      setAdded(true);
      await onAdded();
    },
  });

  return (
    <div>
      <p className="text-sm font-medium text-slate-700">{t('detail.subtree.heading')}</p>
      <p className="text-xs text-slate-400">{t('detail.subtree.explainer')}</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-500">
          <span className="block">{t('detail.subtree.pageId')}</span>
          <input
            value={pageId}
            onChange={(e) => setPageId(e.target.value.replace(/[^0-9]/g, ''))}
            inputMode="numeric"
            className="mt-1 w-32 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="min-w-[12rem] flex-1 text-xs text-slate-500">
          <span className="block">{t('detail.subtree.label')}</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('detail.subtree.labelPlaceholder')}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
            maxLength={500}
          />
        </label>
        <button
          type="button"
          onClick={() => add.mutate()}
          disabled={add.isPending || pageId.trim() === '' || label.trim() === ''}
          className={btnSecondary}
        >
          {t('common:action.add')}
        </button>
      </div>
      {added && <p className="mt-1 text-xs text-slate-500">{t('detail.subtree.added')}</p>}
      {add.isError && (
        <p className="mt-1 text-xs text-red-700 dark:text-red-300">
          {apiError(add.error, 'detail.subtree.failed')}
        </p>
      )}
    </div>
  );
}

/** Backfill bounds and the daily cap; "everything" is an explicit, labelled
 * unbounded choice, never a default. */
function ConnectorBackfillSettings({
  session,
  id,
  settings,
  onSaved,
}: {
  session: Session;
  id: string;
  settings: ConnectorSettingsDto;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useTranslation('connections');
  const apiError = useApiErrorMessage(t);
  const [days, setDays] = useState(settings.backfillDays?.toString() ?? '');
  const [itemCap, setItemCap] = useState(settings.backfillItemCap?.toString() ?? '');
  const [all, setAll] = useState(settings.backfillAll ?? false);
  const [dailyCap, setDailyCap] = useState(settings.dailyItemCap?.toString() ?? '');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDays(settings.backfillDays?.toString() ?? '');
    setItemCap(settings.backfillItemCap?.toString() ?? '');
    setAll(settings.backfillAll ?? false);
    setDailyCap(settings.dailyItemCap?.toString() ?? '');
  }, [
    settings.backfillDays,
    settings.backfillItemCap,
    settings.backfillAll,
    settings.dailyItemCap,
  ]);

  const save = useMutation({
    mutationFn: () =>
      updateConnectorSettings(session, id, {
        ...(days.trim() !== '' ? { backfillDays: Number(days) } : {}),
        ...(itemCap.trim() !== '' ? { backfillItemCap: Number(itemCap) } : {}),
        backfillAll: all,
        ...(dailyCap.trim() !== '' ? { dailyItemCap: Number(dailyCap) } : {}),
      }),
    onSuccess: async () => {
      setSaved(true);
      await onSaved();
    },
  });

  const numeric = (setter: (value: string) => void) => (e: ChangeEvent<HTMLInputElement>) =>
    setter(e.target.value.replace(/[^0-9]/g, ''));

  return (
    <div>
      <p className="text-sm font-medium text-slate-700">{t('detail.backfill.heading')}</p>
      <p className="text-xs text-slate-400">{t('detail.backfill.explainer')}</p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-500">
          <span className="block">{t('detail.backfill.days')}</span>
          <input
            value={days}
            onChange={numeric(setDays)}
            disabled={all}
            className="mt-1 w-24 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-slate-500">
          <span className="block">{t('detail.backfill.itemCap')}</span>
          <input
            value={itemCap}
            onChange={numeric(setItemCap)}
            disabled={all}
            className="mt-1 w-24 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-slate-500">
          <span className="block">{t('detail.backfill.dailyItemCap')}</span>
          <input
            value={dailyCap}
            onChange={numeric(setDailyCap)}
            className="mt-1 w-24 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className={btnSecondary}
        >
          {t('common:action.save')}
        </button>
        {saved && <span className="text-xs text-slate-500">{t('common:state.saved')}</span>}
      </div>
      <label className="mt-2 flex items-start gap-2">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
          className="mt-0.5 rounded border-slate-300"
        />
        <span className="text-xs text-slate-500">
          <span className="font-medium text-slate-700">{t('detail.backfill.everything')}</span>
          <span className="block">{t('detail.backfill.everythingHelp')}</span>
        </span>
      </label>
      {save.isError && (
        <p className="mt-1 text-xs text-red-700 dark:text-red-300">
          {apiError(save.error, 'detail.backfill.saveFailed')}
        </p>
      )}
    </div>
  );
}

/** The reading layer's detected formats — the document classes rules bind to. */
const EXTRACTION_DOCUMENT_CLASSES = ['pdf', 'docx', 'xlsx', 'csv', 'image'];

/** Refusal reasons the ledger records; unknown values render raw, as email does. */
const EXTRACTION_REFUSAL_REASONS = [
  'extraction_disabled',
  'source_disabled',
  'document_class_denied',
];

/**
 * The extraction gate (V2.1 item 4.3): per-connector admission control over
 * extraction. One row per extraction-capable source type (enable, fact budget,
 * retention), document-class rules for files, and the recent refusals so a
 * gated source never silently disappears.
 */
function ExtractionGateSection({ session }: { session: Session }) {
  const { t } = useTranslation('extraction');
  const apiError = useApiErrorMessage(t);
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: ['extraction-gate'],
    queryFn: () => fetchExtractionGateConfig(session),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['extraction-gate'] });

  const [ruleClass, setRuleClass] = useState('image');
  const [ruleEffect, setRuleEffect] = useState<'allow' | 'deny'>('deny');

  const addRule = useMutation({
    mutationFn: () =>
      addExtractionGateRule(session, {
        sourceType: 'file',
        dimension: 'document_class',
        value: ruleClass,
        effect: ruleEffect,
      }),
    onSuccess: invalidate,
  });
  const removeRule = useMutation({
    mutationFn: (id: string) => removeExtractionGateRule(session, id),
    onSuccess: invalidate,
  });

  const gates = new Map((config.data?.gates ?? []).map((gate) => [gate.sourceType, gate]));
  const rules = (config.data?.rules ?? []).filter((rule) => rule.dimension === 'document_class');
  const refusals = config.data?.recentRefusals ?? [];

  const typeLabel = (sourceType: string): string =>
    t(`sourceType.${sourceType}`, { defaultValue: sourceType });

  return (
    <section className="mt-4 space-y-4 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>{t('heading')}</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">
          <Trans i18nKey="explainer" ns="extraction" components={{ b: <strong /> }} />
        </p>
      </div>

      {config.isPending && <Skeleton className="h-24 w-full" />}

      {config.data && (
        <>
          <div>
            <div className="text-sm font-medium text-slate-700">{t('connectors.heading')}</div>
            <p className="text-xs text-slate-400">{t('connectors.explainer')}</p>
            <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
              {config.data.sourceTypes.map((sourceType) => (
                <ExtractionGateRow
                  key={sourceType}
                  session={session}
                  sourceType={sourceType}
                  label={typeLabel(sourceType)}
                  gate={gates.get(sourceType)}
                  onSaved={invalidate}
                />
              ))}
            </ul>
          </div>

          <div>
            <div className="text-sm font-medium text-slate-700">{t('rules.heading')}</div>
            <p className="text-xs text-slate-400">{t('rules.explainer')}</p>
            {rules.length > 0 && (
              <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
                {rules.map((rule) => (
                  <li key={rule.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0 text-sm text-slate-700">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                        {t(`rules.effectValue.${rule.effect}`)}
                      </span>{' '}
                      <span className="font-mono">
                        {t(`rules.class.${rule.value}`, { defaultValue: rule.value })}
                      </span>
                      <span className="ml-2 text-xs text-slate-400">
                        {typeLabel(rule.sourceType)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeRule.mutate(rule.id)}
                      disabled={removeRule.isPending}
                      className="shrink-0 text-xs text-red-700 dark:text-red-300 hover:underline"
                    >
                      {t('common:action.remove')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="text-xs text-slate-500">
                <span className="block">{t('rules.effect')}</span>
                <select
                  value={ruleEffect}
                  onChange={(e) => setRuleEffect(e.target.value as 'allow' | 'deny')}
                  className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                >
                  <option value="deny">{t('rules.effectValue.deny')}</option>
                  <option value="allow">{t('rules.effectValue.allow')}</option>
                </select>
              </label>
              <label className="text-xs text-slate-500">
                <span className="block">{t('rules.documentClass')}</span>
                <select
                  value={ruleClass}
                  onChange={(e) => setRuleClass(e.target.value)}
                  className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                >
                  {EXTRACTION_DOCUMENT_CLASSES.map((value) => (
                    <option key={value} value={value}>
                      {t(`rules.class.${value}`)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => addRule.mutate()}
                disabled={addRule.isPending}
                className={btnPrimary}
              >
                {t('common:action.add')}
              </button>
            </div>
            {addRule.isError && (
              <p className="mt-1 text-xs text-red-700 dark:text-red-300">
                {apiError(addRule.error, 'rules.addFailed')}
              </p>
            )}
          </div>

          {refusals.length > 0 && (
            <div>
              <div className="text-sm font-medium text-slate-700">{t('refusals.heading')}</div>
              <p className="text-xs text-slate-400">{t('refusals.explainer')}</p>
              <ul className="mt-2 space-y-1">
                {refusals.map((refusal) => (
                  <li
                    key={refusal.id}
                    className="flex items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-1.5"
                  >
                    <span className="min-w-0 truncate text-sm text-slate-600">
                      <span>{typeLabel(refusal.sourceType)}</span>
                      {refusal.documentClass && (
                        <span className="ml-2 font-mono text-xs">
                          {t(`rules.class.${refusal.documentClass}`, {
                            defaultValue: refusal.documentClass,
                          })}
                        </span>
                      )}
                      <span className="ml-2 text-xs text-slate-400">
                        {EXTRACTION_REFUSAL_REASONS.includes(refusal.reason)
                          ? t(`refusalReason.${refusal.reason}`)
                          : refusal.reason}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-slate-400">
                      {timeAgo(refusal.refusedAt)}
                    </span>
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

/** One connector's gate row: enable, fact budget, retention, saved per row. */
function ExtractionGateRow({
  session,
  sourceType,
  label,
  gate,
  onSaved,
}: {
  session: Session;
  sourceType: string;
  label: string;
  gate?: { enabled: boolean; factBudget: number | null; retentionDays: number | null };
  onSaved: () => void;
}) {
  const { t } = useTranslation('extraction');
  const apiError = useApiErrorMessage(t);
  const [enabled, setEnabled] = useState(gate?.enabled ?? true);
  const [budget, setBudget] = useState(gate?.factBudget?.toString() ?? '');
  const [retention, setRetention] = useState(gate?.retentionDays?.toString() ?? '');

  useEffect(() => {
    setEnabled(gate?.enabled ?? true);
    setBudget(gate?.factBudget?.toString() ?? '');
    setRetention(gate?.retentionDays?.toString() ?? '');
  }, [gate?.enabled, gate?.factBudget, gate?.retentionDays]);

  const dirty =
    enabled !== (gate?.enabled ?? true) ||
    budget !== (gate?.factBudget?.toString() ?? '') ||
    retention !== (gate?.retentionDays?.toString() ?? '');

  const save = useMutation({
    mutationFn: () =>
      setExtractionGate(session, sourceType, {
        enabled,
        factBudget: budget.trim() === '' ? null : Number(budget),
        retentionDays: retention.trim() === '' ? null : Number(retention),
      }),
    onSuccess: onSaved,
  });

  return (
    <li className="flex flex-wrap items-end gap-3 px-3 py-2">
      <label className="flex min-w-[10rem] flex-1 items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="rounded border-slate-300"
        />
        {label}
      </label>
      <label className="text-xs text-slate-500">
        <span className="block">{t('connectors.factBudget')}</span>
        <input
          value={budget}
          onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder={t('connectors.factBudgetPlaceholder')}
          className="mt-1 w-24 rounded-md border border-slate-300 px-2 py-1 text-sm"
        />
      </label>
      <label className="text-xs text-slate-500">
        <span className="block">{t('connectors.retention')}</span>
        <input
          value={retention}
          onChange={(e) => setRetention(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder={t('connectors.retentionPlaceholder')}
          className="mt-1 w-24 rounded-md border border-slate-300 px-2 py-1 text-sm"
        />
      </label>
      <button
        type="button"
        onClick={() => save.mutate()}
        disabled={!dirty || save.isPending}
        className={btnSecondary}
      >
        {t('common:action.save')}
      </button>
      {save.isError && (
        <span className="text-xs text-red-700 dark:text-red-300">
          {apiError(save.error, 'connectors.saveFailed')}
        </span>
      )}
    </li>
  );
}

/**
 * Entity aliases (V2.3 item 6.1): the owner's recorded equivalences behind
 * alias-aware contradiction pairing, cross-language names above all. The list
 * stays a record of what the DATA adds: a pair the folding rules already
 * unify is refused by the API with the reason, surfaced verbatim below.
 */
function EntityAliasesSection({ session }: { session: Session }) {
  const { t } = useTranslation('settings');
  const apiError = useApiErrorMessage(t);
  const queryClient = useQueryClient();
  const aliases = useQuery({
    queryKey: ['reconcile-aliases'],
    queryFn: () => fetchEntityAliases(session),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['reconcile-aliases'] });

  const [canonical, setCanonical] = useState('');
  const [alias, setAlias] = useState('');

  const add = useMutation({
    mutationFn: () => addEntityAlias(session, { canonical: canonical.trim(), alias: alias.trim() }),
    onSuccess: async () => {
      setCanonical('');
      setAlias('');
      await invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeEntityAlias(session, id),
    onSuccess: invalidate,
  });

  return (
    <section className="mt-4 space-y-4 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>{t('aliases.heading')}</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">{t('aliases.explainer')}</p>
      </div>

      {aliases.isPending && <Skeleton className="h-16 w-full" />}
      {aliases.isError && (
        <p className="text-xs text-red-700 dark:text-red-300">{t('aliases.error')}</p>
      )}

      {aliases.data && (
        <>
          {aliases.data.length === 0 ? (
            <p className="text-xs text-slate-400">{t('aliases.empty')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
              {aliases.data.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate text-sm text-slate-700">
                    {t('aliases.pair', { canonical: row.canonical, alias: row.alias })}
                  </span>
                  <button
                    type="button"
                    onClick={() => remove.mutate(row.id)}
                    disabled={remove.isPending}
                    className="shrink-0 text-xs text-red-700 dark:text-red-300 hover:underline"
                  >
                    {t('common:action.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-500">
              <span className="block">{t('aliases.canonical')}</span>
              <input
                value={canonical}
                onChange={(e) => setCanonical(e.target.value)}
                placeholder={t('aliases.canonicalPlaceholder')}
                className="mt-1 w-56 rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-slate-500">
              <span className="block">{t('aliases.alias')}</span>
              <input
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder={t('aliases.aliasPlaceholder')}
                className="mt-1 w-56 rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <button
              type="button"
              onClick={() => add.mutate()}
              disabled={add.isPending || !canonical.trim() || !alias.trim()}
              className={btnPrimary}
            >
              {t('common:action.add')}
            </button>
          </div>
          {add.isError && (
            <p className="text-xs text-red-700 dark:text-red-300">
              {apiError(add.error, 'saveFailed')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
