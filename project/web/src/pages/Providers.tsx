import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PROVIDER_TYPES } from '@cogeto/shared';
import type { ProviderDto, ProviderType, StoredProviderType } from '@cogeto/shared';
import {
  createProvider,
  deleteProvider,
  fetchProviders,
  probeProvider,
  updateProvider,
} from '../api';
import type { Session } from '../auth/oidc';
import { Shell } from '../components/Shell';
import { ProviderMark } from '../components/ProviderMark';
import {
  btnDanger,
  btnPrimary,
  btnSecondary,
  EmptyState,
  ErrorState,
  Pill,
  SectionTitle,
  SkeletonRows,
} from '../components/ui';
import type { Tone } from '../components/status';
import { fetchMe } from '../api';
import { useApiErrorMessage } from '../i18n/api-error';

/**
 * The providers page (V2.4 item 7.1): every endpoint this instance can reach,
 * what it is, whether it holds a key, and whether it answered.
 *
 * An admin should understand the whole thing in five seconds without reading
 * documentation, which is why the list is one row per provider and the form
 * asks only for what the chosen type actually needs.
 *
 * **A key is never rendered.** The API does not return one; the row shows that
 * a key is present and offers to replace it, and replacing means typing a new
 * one, never seeing the old.
 */
export function Providers({ session }: { session: Session }) {
  const { t } = useTranslation('providers');
  const me = useQuery({ queryKey: ['me'], queryFn: () => fetchMe(session) });
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => fetchProviders(session),
    enabled: me.data?.isAdmin !== false,
  });
  const [adding, setAdding] = useState(false);

  if (me.data && !me.data.isAdmin) {
    return (
      <Shell session={session} title={t('page.title')} active="providers">
        <EmptyState icon="🔒" title={t('adminOnly.title')}>
          {t('adminOnly.body')}
        </EmptyState>
      </Shell>
    );
  }

  return (
    <Shell session={session} title={t('page.title')} active="providers">
      <section className="space-y-4 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <SectionTitle>{t('list.heading')}</SectionTitle>
            <p className="mt-1 text-xs text-slate-400">{t('list.explainer')}</p>
          </div>
          {!adding && (
            <button type="button" className={btnPrimary} onClick={() => setAdding(true)}>
              {t('list.add')}
            </button>
          )}
        </div>

        {adding && (
          <AddProviderForm
            session={session}
            onDone={() => setAdding(false)}
            onCancel={() => setAdding(false)}
          />
        )}

        {providers.isPending && <SkeletonRows rows={3} />}
        {providers.isError && (
          <ErrorState onRetry={() => void providers.refetch()}>{t('list.error')}</ErrorState>
        )}
        {providers.data?.length === 0 && !adding && (
          <EmptyState icon="⛓" title={t('list.empty.title')}>
            {t('list.empty.body')}
          </EmptyState>
        )}
        <ul className="space-y-2">
          {(providers.data ?? []).map((provider) => (
            <ProviderRow key={provider.id} session={session} provider={provider} />
          ))}
        </ul>
      </section>
    </Shell>
  );
}

/** Health as a chip: an icon, a word, and a tone. Never colour alone. */
function HealthChip({ provider }: { provider: ProviderDto }) {
  const { t } = useTranslation('providers');
  const tone: Tone =
    provider.health.state === 'ok'
      ? 'positive'
      : provider.health.state === 'unknown'
        ? 'neutral'
        : 'danger';
  const icon =
    provider.health.state === 'ok' ? '✓' : provider.health.state === 'unknown' ? '·' : '✕';
  return (
    <Pill tone={tone} icon={icon}>
      <span>{t(`health.${provider.health.state}`)}</span>
    </Pill>
  );
}

function ProviderRow({ session, provider }: { session: Session; provider: ProviderDto }) {
  const { t } = useTranslation('providers');
  const apiError = useApiErrorMessage(t);
  const queryClient = useQueryClient();
  const [replacingKey, setReplacingKey] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['providers'] });
    await queryClient.invalidateQueries({ queryKey: ['model-configuration'] });
  };

  const probe = useMutation({
    mutationFn: () => probeProvider(session, provider.id),
    onSuccess: invalidate,
  });
  const saveKey = useMutation({
    mutationFn: () => updateProvider(session, provider.id, { apiKey: newKey }),
    onSuccess: async () => {
      setReplacingKey(false);
      setNewKey('');
      await invalidate();
    },
    onError: (error: Error) => setFailure(apiError(error)),
  });
  const remove = useMutation({
    mutationFn: () => deleteProvider(session, provider.id),
    onSuccess: invalidate,
    onError: (error: Error) => setFailure(apiError(error)),
  });

  return (
    <li className="rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <ProviderMark type={provider.type} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-slate-800">
            {provider.label}
          </span>
          <span className="block truncate text-xs text-slate-500">
            {t(`type.${provider.type}.name`)}
            {provider.baseUrl ? ` · ${provider.baseUrl}` : ''}
          </span>
        </span>
        <span className="text-xs text-slate-500">
          {provider.hasApiKey ? t('key.present') : t('key.absent')}
        </span>
        <HealthChip provider={provider} />
        <button
          type="button"
          className={btnSecondary}
          disabled={probe.isPending}
          onClick={() => probe.mutate()}
        >
          {probe.isPending ? t('action.testing') : t('action.test')}
        </button>
      </div>

      {provider.health.detail && (
        <p className="mt-2 text-xs text-slate-500">{provider.health.detail}</p>
      )}
      {provider.assignedTiers.length > 0 && (
        <p className="mt-2 text-xs text-slate-400">
          {t('list.servingTiers', {
            tiers: provider.assignedTiers.map((tier) => t(`tier.${tier}`)).join(', '),
          })}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!replacingKey && (
          <button type="button" className={btnSecondary} onClick={() => setReplacingKey(true)}>
            {provider.hasApiKey ? t('key.replace') : t('key.add')}
          </button>
        )}
        {replacingKey && (
          <>
            <label className="sr-only" htmlFor={`key-${provider.id}`}>
              {t('form.apiKey.label')}
            </label>
            <input
              id={`key-${provider.id}`}
              type="password"
              autoComplete="off"
              value={newKey}
              onChange={(event) => setNewKey(event.target.value)}
              placeholder={t('form.apiKey.placeholder')}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm"
            />
            <button
              type="button"
              className={btnPrimary}
              disabled={!newKey || saveKey.isPending}
              onClick={() => saveKey.mutate()}
            >
              {saveKey.isPending ? t('action.saving') : t('action.save')}
            </button>
            <button
              type="button"
              className={btnSecondary}
              onClick={() => {
                setReplacingKey(false);
                setNewKey('');
              }}
            >
              {t('action.cancel')}
            </button>
          </>
        )}
        <button
          type="button"
          className={`${btnDanger} ml-auto`}
          disabled={provider.assignedTiers.length > 0 || remove.isPending}
          title={provider.assignedTiers.length > 0 ? t('list.cannotDelete') : undefined}
          onClick={() => remove.mutate()}
        >
          {t('action.remove')}
        </button>
      </div>
      {failure && (
        <p className="mt-2 text-xs text-red-700 dark:text-red-300" role="alert">
          {failure}
        </p>
      )}
    </li>
  );
}

/**
 * Adding a provider: a short form that ADAPTS to the type, asking only for what
 * that type needs. The reachability hint under the endpoint field is the one
 * that saves the most common hour of confusion on a self-hosted deployment.
 */
function AddProviderForm({
  session,
  onDone,
  onCancel,
}: {
  session: Session;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('providers');
  const apiError = useApiErrorMessage(t);
  const queryClient = useQueryClient();
  const [type, setType] = useState<ProviderType>('self_hosted');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const needsBaseUrl = type === 'self_hosted';
  const needsApiKey = type !== 'self_hosted';

  const create = useMutation({
    mutationFn: () =>
      createProvider(session, {
        label,
        type,
        ...(needsBaseUrl || baseUrl ? { baseUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['providers'] });
      await queryClient.invalidateQueries({ queryKey: ['model-configuration'] });
      onDone();
    },
    onError: (error: Error) => setFailure(apiError(error)),
  });

  return (
    <form
      className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setFailure(null);
        create.mutate();
      }}
    >
      <fieldset>
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t('form.type.legend')}
        </legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {PROVIDER_TYPES.map((candidate) => (
            <label
              key={candidate}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${
                type === candidate
                  ? 'border-brand-teal bg-brand-teal-surface/40 dark:bg-brand-teal/10'
                  : 'border-slate-300'
              }`}
            >
              <input
                type="radio"
                name="provider-type"
                className="mt-1"
                checked={type === candidate}
                onChange={() => setType(candidate)}
              />
              <ProviderMark type={candidate as StoredProviderType} className="mt-0.5 h-10 w-10" />
              <span className="min-w-0">
                <span className="block font-medium text-slate-800">
                  {t(`type.${candidate}.name`)}
                </span>
                {/* Self-hosted carries the subtitle that makes the promise
                    accurate: the name sells the sovereignty, this says what it
                    actually accepts. */}
                <span className="block text-xs text-slate-500">
                  {t(`type.${candidate}.subtitle`)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block text-sm">
        <span className="font-medium text-slate-700">{t('form.label.label')}</span>
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          required
          maxLength={120}
          placeholder={t('form.label.placeholder')}
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        <span className="mt-1 block text-xs text-slate-400">{t('form.label.help')}</span>
      </label>

      {needsBaseUrl && (
        <label className="block text-sm">
          <span className="font-medium text-slate-700">{t('form.baseUrl.label')}</span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            required
            inputMode="url"
            placeholder={t('form.baseUrl.placeholder')}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
          {/* The hint, beside the field rather than as a wall of help text. */}
          <span className="mt-1 block text-xs text-slate-400">{t('form.baseUrl.hint')}</span>
        </label>
      )}

      <label className="block text-sm">
        <span className="font-medium text-slate-700">
          {needsApiKey ? t('form.apiKey.label') : t('form.apiKey.optionalLabel')}
        </span>
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          required={needsApiKey}
          placeholder={t('form.apiKey.placeholder')}
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        <span className="mt-1 block text-xs text-slate-400">{t('form.apiKey.help')}</span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={btnPrimary} disabled={create.isPending}>
          {create.isPending ? t('action.testing') : t('form.submit')}
        </button>
        <button type="button" className={btnSecondary} onClick={onCancel}>
          {t('action.cancel')}
        </button>
      </div>
      {failure && (
        <p className="text-xs text-red-700 dark:text-red-300" role="alert">
          {failure}
        </p>
      )}
    </form>
  );
}
