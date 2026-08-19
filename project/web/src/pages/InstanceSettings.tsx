import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import type { ContextSuggestionDto, ModelConfigDto, PreferredLanguage } from '@cogeto/shared';
import type { TFunction } from 'i18next';
import { LANGUAGE_ENDONYMS, MEASURED_LANGUAGES, SUPPORTED_LANGUAGES } from '@cogeto/shared';
import {
  acceptContextSuggestion,
  dismissContextSuggestion,
  fetchAnswerModel,
  fetchContextSuggestions,
  fetchInstancePublicKey,
  fetchMe,
  fetchModelConfig,
  fetchUserContext,
  updateAnswerModel,
  updateUserContext,
} from '../api';
import type { Session } from '../auth/oidc';
import { formatLongDayMonth, localeTag } from '../i18n/format';
import { btnPrimary, btnSecondary, SectionTitle, Skeleton } from '../components/ui';
import { useTheme } from '../theme';
import type { Theme } from '../theme';

/**
 * The instance-level parts of Settings (the settings split,
 * docs/features/spaces.md section 4): identity, appearance and
 * infrastructure, which do NOT change with the space switcher. Profile and
 * context, the theme, the user's answer-model choice, the read-only model
 * configuration and the instance signing key all describe the person or the
 * deployment, so they moved here, into the instance area, out of the
 * space-scoped Settings page. What is extracted, stored, retrieved or
 * answered stays configured per space on that page.
 */
export function InstanceSettings({ session }: { session: Session }) {
  const { t } = useTranslation('settings');
  const publicKey = useQuery({ queryKey: ['instance-key'], queryFn: fetchInstancePublicKey });

  return (
    <>
      {/* The level, stated where the settings are shown (issue C4): nothing
          on this page belongs to a space. */}
      <p className="rounded-lg border border-slate-200 bg-slate-100/60 px-4 py-2.5 text-xs text-slate-500 dark:bg-white/5">
        {t('level.instance')}
      </p>

      <ProfileContextSection session={session} />

      <AppearanceSection />

      <AnswerModelSection session={session} />

      <ModelConfigSection session={session} />

      <section className="space-y-2 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
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
    </>
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
    <section className="space-y-4 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
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
    <section className="space-y-3 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
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
    <section className="space-y-3 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
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
/**
 * What leaves the instance, in the reader's language (F13).
 *
 * The server names the case and the providers; the sentence is written here,
 * and the providers are joined by the reader's own language rules rather than
 * by an English "and". `externalCalls` stays the fallback for a case a newer
 * server knows and this interface does not.
 */
function externalCallsSentence(t: TFunction, config: ModelConfigDto): string {
  const key = {
    unconfigured: 'models.externalCalls.unconfigured',
    all_local: 'models.externalCalls.allLocal',
    redacted: 'models.externalCalls.redacted',
    external: 'models.externalCalls.external',
  }[config.externalCallsKind] as string | undefined;
  if (key === undefined) return config.externalCalls;
  const providers = new Intl.ListFormat(localeTag(), { type: 'conjunction' }).format(
    config.externalCallsProviders.map((id) => t(`models.providerLabel.${id}`)),
  );
  return t(key, { providers });
}

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
    <section className="space-y-3 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
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
          <p className="text-xs text-slate-500">{externalCallsSentence(t, config.data)}</p>
          {me.data?.isAdmin === true && (
            <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-3">
              <a href="/instance/models" className={btnSecondary}>
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
