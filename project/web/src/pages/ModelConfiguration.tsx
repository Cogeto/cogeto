import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import type { ModelConfigurationDto, ProviderAssignmentDto, ProviderDto } from '@cogeto/shared';
import {
  addAnswerOption,
  assignModelTier,
  fetchMe,
  fetchModelConfiguration,
  fetchProviderModels,
  fetchProviders,
  removeAnswerOption,
} from '../api';
import type { Session } from '../auth/oidc';
import { Shell } from '../components/Shell';
import { ProviderMark } from '../components/ProviderMark';
import {
  btnPrimary,
  btnSecondary,
  EmptyState,
  ErrorState,
  Pill,
  SectionTitle,
  SkeletonRows,
} from '../components/ui';
import { formatPercent } from '../i18n/format';

/**
 * The model assignment page (V2.4 item 7.1): four rows, one per tier.
 *
 * Two things the page must never let an admin do by accident, and both are
 * visible rather than hidden behind a validation error:
 *
 * - **Change the embeddings model.** Every stored vector was produced by the
 *   current one, so a change needs the index rebuilt. The managed rebuild is
 *   the next release; the row states that and names the operator command.
 * - **Move onto an unmeasured configuration without noticing.** The published
 *   trust score for the exact configuration in force is shown, and its absence
 *   is stated in words rather than left blank.
 *
 * Nothing saves on selection: a change is chosen, then confirmed.
 */
export function ModelConfiguration({ session }: { session: Session }) {
  const { t } = useTranslation('providers');
  const me = useQuery({ queryKey: ['me'], queryFn: () => fetchMe(session) });
  const configuration = useQuery({
    queryKey: ['model-configuration'],
    queryFn: () => fetchModelConfiguration(session),
    enabled: me.data?.isAdmin !== false,
  });
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => fetchProviders(session),
    enabled: me.data?.isAdmin !== false,
  });

  if (me.data && !me.data.isAdmin) {
    return (
      <Shell session={session} title={t('assignment.title')} active="models">
        <EmptyState icon="🔒" title={t('adminOnly.title')}>
          {t('adminOnly.body')}
        </EmptyState>
      </Shell>
    );
  }

  const data = configuration.data;

  return (
    <Shell session={session} title={t('assignment.title')} active="models">
      <section className="space-y-4 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
        <div>
          <SectionTitle>{t('assignment.heading')}</SectionTitle>
          <p className="mt-1 text-xs text-slate-400">{t('assignment.explainer')}</p>
        </div>

        {configuration.isPending && <SkeletonRows rows={4} />}
        {configuration.isError && (
          <ErrorState onRetry={() => void configuration.refetch()}>
            {t('assignment.error')}
          </ErrorState>
        )}

        {data && <ConfigurationSummary configuration={data} />}

        {data &&
          data.assignments.map((assignment) => (
            <TierRow
              key={assignment.tier}
              session={session}
              assignment={assignment}
              providers={providers.data ?? []}
              locked={assignment.tier === 'embeddings' ? data.embeddingsLocked : null}
            />
          ))}
      </section>

      {data && (
        <AnswerOptionsSection
          session={session}
          configuration={data}
          providers={providers.data ?? []}
        />
      )}

      {data && data.history.length > 0 && (
        <section className="mt-4 space-y-2 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
          <SectionTitle>{t('history.heading')}</SectionTitle>
          <p className="text-xs text-slate-400">{t('history.explainer')}</p>
          <ul className="space-y-1 text-xs text-slate-500">
            {data.history.map((change) => (
              <li key={change.id}>
                <code className="rounded bg-slate-50 px-1.5 py-0.5">{change.configurationId}</code>{' '}
                {t('history.entry', {
                  tier: t(`tier.${change.tier}`),
                  provider: change.providerLabel,
                  model: change.model,
                })}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Shell>
  );
}

/** The configuration id, where it came from, and whether it was measured. */
function ConfigurationSummary({ configuration }: { configuration: ModelConfigurationDto }) {
  const { t } = useTranslation('providers');
  const trust = configuration.trust;
  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-slate-700">{t('summary.configuration')}</span>
        <code className="rounded bg-surface px-2 py-0.5 text-xs text-slate-600">
          {configuration.configurationId}
        </code>
        <Pill
          tone={configuration.configured ? 'positive' : 'warning'}
          icon={configuration.configured ? '✓' : '!'}
        >
          {configuration.configured ? t('summary.configured') : t('summary.notConfigured')}
        </Pill>
        <Pill tone={trust.evaluated ? 'positive' : 'neutral'} icon={trust.evaluated ? '✓' : '·'}>
          {trust.evaluated
            ? t('trust.evaluated', { release: trust.release })
            : t('trust.notEvaluated')}
        </Pill>
      </div>
      {trust.evaluated ? (
        <p className="text-xs text-slate-500">
          {t('trust.numbers', {
            precision: formatPercent(trust.extractionPrecision ?? 0),
            recall: formatPercent(trust.extractionRecall ?? 0),
            agreement: formatPercent(trust.verificationAgreement ?? 0),
          })}
        </p>
      ) : (
        <p className="text-xs text-slate-500">{t('trust.notEvaluatedHelp')}</p>
      )}
      <p className="text-xs text-slate-400">{t(`summary.source.${configuration.source}`)}</p>
    </div>
  );
}

/**
 * One tier. A provider selector, a model selector that always allows manual
 * entry, and a confirm step — never a save on selection.
 */
function TierRow({
  session,
  assignment,
  providers,
  locked,
}: {
  session: Session;
  assignment: ProviderAssignmentDto;
  providers: ProviderDto[];
  locked: { operatorCommand: string } | null;
}) {
  const { t } = useTranslation('providers');
  const queryClient = useQueryClient();
  const [providerId, setProviderId] = useState(assignment.providerId ?? '');
  const [model, setModel] = useState(assignment.model ?? '');
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setProviderId(assignment.providerId ?? '');
    setModel(assignment.model ?? '');
  }, [assignment.providerId, assignment.model]);

  // Discovery: what this endpoint advertises. An OFFER, never an authority —
  // a proxied deployment legitimately serves models it does not list, so the
  // free-text field beside it is the real input and the list only fills it in.
  const models = useQuery({
    queryKey: ['provider-models', providerId],
    queryFn: () => fetchProviderModels(session, providerId),
    enabled: !!providerId && !locked,
    staleTime: 60_000,
  });

  const eligible = providers.filter(
    (provider) => assignment.tier !== 'embeddings' || provider.supportsEmbeddings,
  );
  const dirty =
    providerId !== (assignment.providerId ?? '') || model.trim() !== (assignment.model ?? '');

  const save = useMutation({
    mutationFn: () =>
      assignModelTier(session, assignment.tier, {
        providerId: providerId || null,
        model: model.trim() || null,
      }),
    onSuccess: async () => {
      setFailure(null);
      await queryClient.invalidateQueries({ queryKey: ['model-configuration'] });
      await queryClient.invalidateQueries({ queryKey: ['model-config'] });
    },
    onError: (error: Error) => setFailure(error.message),
  });

  const provider = providers.find((candidate) => candidate.id === assignment.providerId);

  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-40">
          <span className="block text-sm font-semibold text-slate-800">
            {t(`tier.${assignment.tier}`)}
          </span>
          <span className="block text-xs text-slate-400">{t(`tierHelp.${assignment.tier}`)}</span>
        </span>
        {provider && <ProviderMark type={provider.type} />}
        <span className="text-sm text-slate-600">
          {assignment.providerLabel ? (
            <>
              {assignment.providerLabel}
              <span className="text-slate-400"> · </span>
              <code className="text-xs">{assignment.model}</code>
            </>
          ) : (
            t('assignment.unassigned')
          )}
        </span>
      </div>

      {locked ? (
        <div
          className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
          role="note"
        >
          <p>{t('embeddings.locked')}</p>
          <p className="mt-1">
            <Trans
              i18nKey="embeddings.interim"
              ns="providers"
              values={{ command: locked.operatorCommand }}
              components={{ code: <code className="rounded bg-surface px-1.5 py-0.5" /> }}
            />
          </p>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-500">
            <span className="block">{t('assignment.provider')}</span>
            <select
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
              className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
            >
              <option value="">{t('assignment.none')}</option>
              {eligible.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs text-slate-500">
            <span className="block">{t('assignment.model')}</span>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              list={`models-${assignment.tier}`}
              placeholder={t('assignment.modelPlaceholder')}
              className="mt-1 w-64 rounded-md border border-slate-300 px-2 py-1 text-sm"
            />
            <datalist id={`models-${assignment.tier}`}>
              {(models.data?.models ?? []).map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>

          <button
            type="button"
            className={btnPrimary}
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t('action.testing') : t('assignment.apply')}
          </button>
          {dirty && !save.isPending && (
            <button
              type="button"
              className={btnSecondary}
              onClick={() => {
                setProviderId(assignment.providerId ?? '');
                setModel(assignment.model ?? '');
                setFailure(null);
              }}
            >
              {t('action.cancel')}
            </button>
          )}
        </div>
      )}

      {!locked && models.data?.mayBePartial && (
        <p className="mt-2 text-xs text-slate-400">{t('assignment.partialList')}</p>
      )}
      {!locked && models.data?.error && (
        <p className="mt-2 text-xs text-slate-400">
          {t('assignment.listUnavailable', { reason: models.data.error })}
        </p>
      )}
      {assignment.tier === 'vision' && !locked && (
        <p className="mt-2 text-xs text-slate-400">{t('assignment.visionOptional')}</p>
      )}
      {failure && (
        <p className="mt-2 text-xs text-red-700 dark:text-red-300" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}

/** The answer models users may pick between: the admin controls the set. */
function AnswerOptionsSection({
  session,
  configuration,
  providers,
}: {
  session: Session;
  configuration: ModelConfigurationDto;
  providers: ProviderDto[];
}) {
  const { t } = useTranslation('providers');
  const queryClient = useQueryClient();
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [label, setLabel] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['model-configuration'] });
  const add = useMutation({
    mutationFn: () =>
      addAnswerOption(session, { providerId, model: model.trim(), label: label.trim() }),
    onSuccess: async () => {
      setModel('');
      setLabel('');
      setFailure(null);
      await invalidate();
    },
    onError: (error: Error) => setFailure(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeAnswerOption(session, id),
    onSuccess: invalidate,
  });

  return (
    <section className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-surface p-5 shadow-sm">
      <div>
        <SectionTitle>{t('answerOptions.heading')}</SectionTitle>
        <p className="mt-1 text-xs text-slate-400">{t('answerOptions.explainer')}</p>
      </div>

      {configuration.answerOptions.length === 0 ? (
        <p className="text-xs text-slate-500">{t('answerOptions.empty')}</p>
      ) : (
        <ul className="space-y-1">
          {configuration.answerOptions.map((option) => (
            <li key={option.id} className="flex flex-wrap items-center gap-2 text-sm">
              <ProviderMark type={option.providerType} className="h-4 w-4" />
              <span className="font-medium text-slate-700">{option.label}</span>
              <span className="text-xs text-slate-400">
                {option.providerLabel} · {option.model}
              </span>
              <button
                type="button"
                className={`${btnSecondary} ml-auto`}
                onClick={() => remove.mutate(option.id)}
              >
                {t('action.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-500">
          <span className="block">{t('assignment.provider')}</span>
          <select
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">{t('assignment.none')}</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          <span className="block">{t('assignment.model')}</span>
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className="mt-1 w-48 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-slate-500">
          <span className="block">{t('answerOptions.label')}</span>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            className="mt-1 w-40 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <button
          type="button"
          className={btnPrimary}
          disabled={!providerId || !model.trim() || !label.trim() || add.isPending}
          onClick={() => add.mutate()}
        >
          {add.isPending ? t('action.testing') : t('answerOptions.add')}
        </button>
      </div>
      {failure && (
        <p className="text-xs text-red-700 dark:text-red-300" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
