import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import type {
  ContextSuggestionDto,
  EmailAllowlistKind,
  MemoryScope,
  PreferredLanguage,
} from '@cogeto/shared';
import { LANGUAGE_ENDONYMS, MEASURED_LANGUAGES, SUPPORTED_LANGUAGES } from '@cogeto/shared';
import {
  acceptContextSuggestion,
  addEmailAllowlistEntry,
  addEntityAlias,
  addExtractionGateRule,
  dismissContextSuggestion,
  fetchEntityAliases,
  fetchContextSuggestions,
  fetchEmailConfig,
  fetchExtractionGateConfig,
  fetchInstancePublicKey,
  fetchAnswerModel,
  fetchMe,
  fetchModelConfig,
  fetchPassportDownload,
  fetchPassportExports,
  fetchSettings,
  fetchUserContext,
  removeEmailAllowlistEntry,
  removeEntityAlias,
  removeExtractionGateRule,
  setExtractionGate,
  triggerPassportExport,
  updateAnswerModel,
  updateSettings,
  updateUserContext,
} from '../api';
import type { Session } from '../auth/oidc';
import { formatLongDayMonth } from '../i18n/format';
import { Shell } from '../components/Shell';
import { btnPrimary, btnSecondary, SectionTitle, Skeleton } from '../components/ui';
import { timeAgo } from '../components/status';
import { useTheme } from '../theme';
import type { Theme } from '../theme';
import { useAutoResearch } from '../research-pref';

/** Settings: only real, wired toggles — every control does something today. */
export function Settings({ session }: { session: Session }) {
  const { t } = useTranslation('settings');
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
    <Shell session={session} title={t('navigation:section.settings')} active="settings">
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

      <ProfileContextSection session={session} />

      <AppearanceSection />

      <ResearchSection />

      <AnswerModelSection session={session} />

      <ModelConfigSection session={session} />

      <EmailCaptureSection session={session} />

      <ExtractionGateSection session={session} />

      <EntityAliasesSection session={session} />

      <PassportSection session={session} />

      <section className="mt-4 space-y-2 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
        <SectionTitle>{t('signingKey.heading')}</SectionTitle>
        <p className="text-xs text-slate-500">{t('signingKey.explainer')}</p>
        {publicKey.data ? (
          <pre className="overflow-x-auto rounded-md bg-slate-50 p-3 text-xs text-slate-600">
            {publicKey.data.publicKeyPem}
          </pre>
        ) : (
          <Skeleton className="h-16 w-full" />
        )}
        {publicKey.data && (
          <p className="text-xs text-slate-400">
            {t('signingKey.algorithm', { algorithm: publicKey.data.algorithm })}
          </p>
        )}
      </section>
    </Shell>
  );
}

/** The browser's IANA zone list; falls back to a minimal set if unsupported. */
function timeZoneOptions(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Europe/Zagreb', 'Europe/Berlin', 'Europe/London', 'UTC'];
  }
}

/**
 * Profile and context: who the user is, their
 * timezone, and which language Cogeto speaks. Everything here is settings, not
 * memory: it shapes how answers are phrased and interpreted, and is never a
 * citable fact. Suggestions propose company/role values found
 * in the user's own memories; nothing applies without an explicit accept.
 */
function ProfileContextSection({ session }: { session: Session }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const context = useQuery({
    queryKey: ['user-context'],
    queryFn: () => fetchUserContext(session),
  });
  const suggestions = useQuery({
    queryKey: ['context-suggestions'],
    queryFn: () => fetchContextSuggestions(session),
  });

  const [displayName, setDisplayName] = useState('');
  const [company, setCompany] = useState('');
  const [roleTitle, setRoleTitle] = useState('');
  const [aboutWork, setAboutWork] = useState('');
  const [timezone, setTimezone] = useState('');
  const [language, setLanguage] = useState<PreferredLanguage>('en');
  const [strict, setStrict] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (context.data) {
      setDisplayName(context.data.displayName ?? '');
      setCompany(context.data.company ?? '');
      setRoleTitle(context.data.roleTitle ?? '');
      setAboutWork(context.data.aboutWork ?? '');
      setTimezone(context.data.timezone ?? '');
      setLanguage(context.data.preferredLanguage);
      setStrict(context.data.languageStrict);
    }
  }, [context.data]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['user-context'] });
    await queryClient.invalidateQueries({ queryKey: ['context-suggestions'] });
  };

  const save = useMutation({
    mutationFn: () =>
      updateUserContext(session, {
        displayName: displayName.trim() || null,
        company: company.trim() || null,
        roleTitle: roleTitle.trim() || null,
        aboutWork: aboutWork.trim() || null,
        timezone: timezone || null,
        preferredLanguage: language,
        languageStrict: strict,
      }),
    onSuccess: async () => {
      setSaved(true);
      await refresh();
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const accept = useMutation({
    mutationFn: (s: ContextSuggestionDto) =>
      acceptContextSuggestion(session, {
        field: s.field,
        value: s.value,
        sourceMemoryId: s.sourceMemoryId,
      }),
    onSuccess: refresh,
  });
  const dismiss = useMutation({
    mutationFn: (s: ContextSuggestionDto) =>
      dismissContextSuggestion(session, {
        field: s.field,
        value: s.value,
        sourceMemoryId: s.sourceMemoryId,
      }),
    onSuccess: refresh,
  });

  const inputClass = 'w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-700';

  return (
    <section className="mt-4 space-y-4 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>{t('profile.heading')}</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">{t('profile.explainer')}</p>
      </div>

      {context.isPending && <Skeleton className="h-40 w-full" />}
      {context.data && (
        <>
          {(suggestions.data?.suggestions.length ?? 0) > 0 && (
            <div className="space-y-2 rounded-md border border-brand-teal/40 bg-brand-teal/5 p-3">
              {suggestions.data!.suggestions.map((s) => (
                <div key={`${s.field}:${s.value}`} className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-slate-700">
                    <Trans
                      i18nKey={
                        s.field === 'company'
                          ? 'profile.suggestion.company'
                          : 'profile.suggestion.role'
                      }
                      ns="settings"
                      values={{
                        value: s.value,
                        source: s.sourceLabel,
                        date: formatLongDayMonth(s.sourceDate),
                      }}
                      components={{ src: <span className="text-xs text-slate-400" /> }}
                    />
                  </span>
                  <button
                    type="button"
                    className={btnSecondary}
                    disabled={accept.isPending}
                    onClick={() => accept.mutate(s)}
                  >
                    {t('profile.suggestion.accept')}
                  </button>
                  <button
                    type="button"
                    className="text-xs text-slate-400 underline hover:text-slate-600"
                    disabled={dismiss.isPending}
                    onClick={() => dismiss.mutate(s)}
                  >
                    {t('common:action.dismiss')}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm text-slate-700">
              <span className="font-medium">{t('profile.name')}</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t('profile.namePlaceholder')}
                className={`mt-1 ${inputClass}`}
                maxLength={120}
              />
            </label>
            <label className="block text-sm text-slate-700">
              <span className="font-medium">{t('profile.company')}</span>
              <input
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className={`mt-1 ${inputClass}`}
                maxLength={160}
              />
            </label>
            <label className="block text-sm text-slate-700">
              <span className="font-medium">{t('profile.role')}</span>
              <input
                type="text"
                value={roleTitle}
                onChange={(e) => setRoleTitle(e.target.value)}
                className={`mt-1 ${inputClass}`}
                maxLength={120}
              />
            </label>
            <label className="block text-sm text-slate-700">
              <span className="font-medium">{t('profile.timezone')}</span>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className={`mt-1 ${inputClass}`}
              >
                <option value="">
                  {t('profile.instanceDefaultZone', { zone: context.data.effectiveTimezone })}
                </option>
                {timeZoneOptions().map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-slate-700 sm:col-span-2">
              <span className="font-medium">{t('profile.aboutWork')}</span>
              <input
                type="text"
                value={aboutWork}
                onChange={(e) => setAboutWork(e.target.value)}
                placeholder={t('profile.aboutWorkPlaceholder')}
                className={`mt-1 ${inputClass}`}
                maxLength={240}
              />
            </label>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-3 text-sm text-slate-700">
              <span className="font-medium">{t('profile.language')}</span>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as PreferredLanguage)}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
              >
                {/* A language is always listed in its own language, so someone
                    who cannot read the current interface can still find theirs. */}
                {SUPPORTED_LANGUAGES.map((code) => (
                  <option key={code} value={code}>
                    {LANGUAGE_ENDONYMS[code]}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-400">{t('profile.languageHelp')}</span>
            </label>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={strict}
                onChange={(e) => setStrict(e.target.checked)}
                className="mt-1"
              />
              <span className="text-sm text-slate-700">
                <span className="font-medium">{t('profile.strict.label')}</span>
                <span className="block text-xs text-slate-400">{t('profile.strict.help')}</span>
              </span>
            </label>
            {/* Interface language is NOT extraction quality (V2.0 item 3.5,
                Issue C point 4). Only the measured languages have a golden
                corpus and published per-language gates; the rest are interface
                languages, and the product says so where the choice is made. */}
            <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
              {t('profile.qualityNote', {
                measured: MEASURED_LANGUAGES.map((code) => LANGUAGE_ENDONYMS[code]).join(', '),
                unmeasured: SUPPORTED_LANGUAGES.filter(
                  (code) => !(MEASURED_LANGUAGES as readonly string[]).includes(code),
                )
                  .map((code) => LANGUAGE_ENDONYMS[code])
                  .join(', '),
              })}
            </p>
          </div>

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
  );
}

/** Theme VALUES are persisted; only their display names are translated. */
const THEMES: Theme[] = ['dark', 'light'];

/**
 * Appearance: the per-device light/dark choice. Dark is the product
 * default; picking here writes localStorage and applies instantly on every
 * surface, and the pre-paint bootstrap in index.html honours it on the next load
 * with no flash. A segmented control, not a checkbox: two named, explicit states.
 */
function AppearanceSection() {
  const { t } = useTranslation('settings');
  const { theme, setTheme } = useTheme();
  return (
    <section className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>{t('appearance.heading')}</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">{t('appearance.explainer')}</p>
      </div>
      <div
        role="group"
        aria-label={t('appearance.themeLabel')}
        className="flex w-fit gap-1 rounded-lg bg-slate-200/70 p-1"
      >
        {THEMES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={theme === value}
            onClick={() => setTheme(value)}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
              theme === value
                ? 'bg-surface text-slate-800 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {t(`appearance.theme.${value}`)}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Research: when on, a chat answer that would offer web research
 * just runs it — no tap, no gate, no picking. Off by default; stored per device.
 */
function ResearchSection() {
  const { t } = useTranslation('settings');
  const { autoResearch, setAutoResearch } = useAutoResearch();
  return (
    <section className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>{t('research.heading')}</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">{t('research.explainer')}</p>
      </div>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={autoResearch}
          onChange={(e) => setAutoResearch(e.target.checked)}
          className="mt-1"
        />
        <span className="text-sm text-slate-700">
          <span className="font-medium">{t('research.auto.label')}</span>
          <span className="block text-xs text-slate-400">{t('research.auto.help')}</span>
        </span>
      </label>
    </section>
  );
}

/**
 * The one model choice that is a user's own (V2.4 item 7.1): which model writes
 * the answers they read, from the set an administrator enabled.
 *
 * Deliberately the only one. Extraction and embeddings decide what gets
 * remembered and how it is found, and vision decides what gets read off a page:
 * those are instance decisions with an eval gate behind them, not preferences.
 * When an admin has enabled nothing, the section says so and offers nothing,
 * rather than showing an empty control.
 */
function AnswerModelSection({ session }: { session: Session }) {
  const { t } = useTranslation('providers');
  const queryClient = useQueryClient();
  const answerModel = useQuery({
    queryKey: ['answer-model'],
    queryFn: () => fetchAnswerModel(session),
  });
  const choose = useMutation({
    mutationFn: (optionId: string | null) => updateAnswerModel(session, optionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['answer-model'] }),
  });

  const data = answerModel.data;
  return (
    <section className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>{t('userChoice.heading')}</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">{t('userChoice.explainer')}</p>
      </div>
      {answerModel.isPending && <Skeleton className="h-10 w-full" />}
      {data && data.options.length === 0 && (
        <p className="text-xs text-slate-500">{t('userChoice.none')}</p>
      )}
      {data && data.options.length > 0 && (
        <>
          <label className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
            <span className="font-medium">{t('assignment.model')}</span>
            <select
              value={data.optionId ?? ''}
              onChange={(event) => choose.mutate(event.target.value || null)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm"
            >
              <option value="">{t('userChoice.instanceDefault')}</option>
              {data.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-slate-400">
            {t('userChoice.current', { label: data.activeLabel })}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Model configuration: READ-ONLY display of the active
 * provider configuration — the id the trust page joins on, the provider and
 * model per tier, redaction posture, and what leaves the instance. No key
 * input, no editing: keys are operator-set in the instance environment.
 */
function ModelConfigSection({ session }: { session: Session }) {
  const { t } = useTranslation('settings');
  const config = useQuery({
    queryKey: ['model-config'],
    queryFn: () => fetchModelConfig(session),
  });
  // An admin sees ONE extra line: where this is actually changed. Everyone else
  // sees the disclosure unchanged, because which company receives their text is
  // not an operator detail (V2.4 item 7.1).
  const me = useQuery({ queryKey: ['me'], queryFn: () => fetchMe(session) });

  return (
    <section className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>{t('models.heading')}</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">{t('models.explainer')}</p>
      </div>
      {config.isPending && <Skeleton className="h-24 w-full" />}
      {config.data && (
        <>
          <div className="flex items-center gap-2 text-sm text-slate-700">
            <span className="font-medium">{t('models.configuration')}</span>
            <code className="rounded bg-slate-50 px-2 py-0.5 text-xs text-slate-600">
              {config.data.configurationId}
            </code>
            {!config.data.configured && (
              <span className="text-xs text-amber-700 dark:text-amber-300">
                {t('models.notConfigured')}
              </span>
            )}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {/* Tier keys are the gateway's vocabulary; their labels are copy. */}
            {(
              [
                ['pipeline', config.data.tiers.pipeline],
                ['answer', config.data.tiers.answer],
                ['embeddings', config.data.tiers.embeddings],
              ] as const
            ).map(([key, tier]) => (
              <div key={key} className="contents">
                <dt className="text-slate-500">{t(`models.tier.${key}`)}</dt>
                <dd className="text-slate-700">
                  {tier.provider}/{tier.model}
                </dd>
              </div>
            ))}
            <div className="contents">
              <dt className="text-slate-500">{t('models.redaction')}</dt>
              <dd className="text-slate-700">
                {config.data.redactionEnabled
                  ? t('capabilities:state.on')
                  : t('capabilities:state.off')}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-slate-500">{config.data.externalCalls}</p>
          {me.data?.isAdmin === true && (
            <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-3">
              <a href="/models" className={btnSecondary}>
                {t('models.manage')}
                <span aria-hidden="true">→</span>
              </a>
              <span className="text-xs text-slate-400">{t('models.managedIn')}</span>
            </div>
          )}
        </>
      )}
      {config.isError && (
        <p className="text-xs text-red-700 dark:text-red-300">{t('models.error')}</p>
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
    <section className="mt-4 space-y-4 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>{t('heading')}</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">
          <Trans i18nKey="explainer" ns="email" components={{ b: <strong /> }} />
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
              {add.error instanceof Error ? add.error.message : t('allowlist.addFailed')}
            </p>
          )}

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
                            r.fromAddr && add.mutate({ kind: 'address', value: r.fromAddr })
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
                {addRule.error instanceof Error ? addRule.error.message : t('rules.addFailed')}
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
          {save.error instanceof Error ? save.error.message : t('connectors.saveFailed')}
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
              {add.error instanceof Error ? add.error.message : t('saveFailed')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
