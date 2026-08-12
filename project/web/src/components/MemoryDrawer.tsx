import { useState } from 'react';
import { useConfirm } from './confirm';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  approveMemory,
  changeMemoryScope,
  editMemory,
  fetchCitingAnswers,
  fetchContradictions,
  fetchMe,
  fetchMemory,
  fetchMemoryChain,
  fetchMemoryRelations,
  fetchNote,
  fetchVerification,
  markMemoryOutdated,
  rejectMemory,
  setMemorySensitive,
} from '../api';
import type { Session } from '../auth/oidc';
import { invalidateAfterGovernance } from '../query-invalidation';
import { formatShortDate } from '../i18n/format';
import { LocatorChips } from './LocatorChips';
import { SourceDrawer } from './SourceDrawer';
import { RESOLUTION_KEY_SUFFIX } from './relation-labels';
import { timeAgo } from './status';
import {
  btnDanger,
  btnPrimary,
  btnSecondary,
  Drawer,
  EntityChip,
  ErrorState,
  PrivateTag,
  SensitiveBadge,
  SharedBadge,
  SkeletonRows,
  StatusChip,
  VerdictChip,
} from './ui';

const EDIT_EXPLAINED_KEY = 'cogeto-supersession-explained';

/** Deep-link into the time-travel view for a subject, optionally at an instant. */
function timelineHref(subject: string, at?: string | null): string {
  const params = new URLSearchParams({ subject });
  if (at) {
    params.set('mode', 'at');
    params.set('at', at);
  }
  return `/timeline?${params.toString()}`;
}

/** Enum → key map (AGENTS.md): unknown values render raw, never a broken key. */
function relationResolutionLabel(t: TFunction, resolution: string | null): string {
  const suffix = RESOLUTION_KEY_SUFFIX[resolution ?? ''];
  return suffix ? t(`drawer.resolutionLabel.${suffix}`) : (resolution ?? '');
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The governance drawer: full content, allowed actions, verification
 * verdict, provenance, and the supersession history — every trust claim next
 * to its artifact. Server-side guards are the authority; buttons here only
 * hide what is never legal for the current status.
 */
export function MemoryDrawer({
  session,
  memoryId,
  onClose,
  onNavigate,
}: {
  session: Session;
  memoryId: string;
  onClose: () => void;
  /** Re-target the drawer (edit jumps to the successor). */
  onNavigate: (memoryId: string) => void;
}) {
  const { t } = useTranslation('memories');
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [showSource, setShowSource] = useState(false);
  const [showExplainer] = useState(() => !localStorage.getItem(EDIT_EXPLAINED_KEY));

  const memoryQuery = useQuery({
    queryKey: ['memory', memoryId],
    queryFn: () => fetchMemory(session, memoryId),
  });
  const memory = memoryQuery.data;
  // Ownership drives which actions are offered. The server enforces
  // owner-only regardless; the UI hides what a non-owner may never do and
  // explains why. `me` is cached by the Shell — this is a free read.
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => fetchMe(session) });
  const isMine = memory ? memory.ownerId === me?.userId : false;

  const chainQuery = useQuery({
    queryKey: ['memory-chain', memoryId],
    queryFn: () => fetchMemoryChain(session, memoryId),
    enabled: Boolean(memory),
  });
  const verificationQuery = useQuery({
    queryKey: ['verification', memoryId],
    queryFn: () => fetchVerification(session, memoryId),
    enabled: Boolean(memory),
    retry: false, // 404 = user-authored, no verification pass — not an error
  });
  const noteQuery = useQuery({
    queryKey: ['note', memory?.sourceId],
    queryFn: () => fetchNote(session, memory!.sourceId),
    enabled: memory?.sourceType === 'user_note',
  });
  // The fact's whole life (V2.2 item 5.2): every contradiction relation it is
  // party to (resolved included), and the answers that cited it.
  const relationsQuery = useQuery({
    queryKey: ['memory-relations', memoryId],
    queryFn: () => fetchMemoryRelations(session, memoryId),
    enabled: Boolean(memory),
  });
  const citingQuery = useQuery({
    queryKey: ['memory-citing', memoryId],
    queryFn: () => fetchCitingAnswers(session, memoryId),
    enabled: Boolean(memory) && isMine,
  });
  // Contradicted memories show the OTHER side of the conflict right here —
  // the warning chip's promise is both facts, both sources.
  const contradictionsQuery = useQuery({
    queryKey: ['contradictions'],
    queryFn: () => fetchContradictions(session),
    enabled: memory?.status === 'contradicted',
  });
  const contradiction = contradictionsQuery.data?.find(
    (relation) => relation.a.id === memoryId || relation.b.id === memoryId,
  );
  const otherSide = contradiction
    ? contradiction.a.id === memoryId
      ? contradiction.b
      : contradiction.a
    : null;
  const otherNoteQuery = useQuery({
    queryKey: ['note', otherSide?.sourceId],
    queryFn: () => fetchNote(session, otherSide!.sourceId),
    enabled: otherSide?.sourceType === 'user_note',
  });

  const refresh = async () => {
    setActionError(null);
    // Chat chips, lists, badges — the governance-affected queries only.
    await invalidateAfterGovernance(queryClient);
  };
  const onError = (error: unknown) =>
    setActionError(error instanceof Error ? error.message : String(error));

  const approve = useMutation({
    mutationFn: () => approveMemory(session, memoryId),
    onSuccess: refresh,
    onError,
  });
  const outdate = useMutation({
    mutationFn: () => markMemoryOutdated(session, memoryId),
    onSuccess: refresh,
    onError,
  });
  const sensitive = useMutation({
    mutationFn: (value: boolean) => setMemorySensitive(session, memoryId, value),
    onSuccess: refresh,
    onError,
  });
  const scope = useMutation({
    mutationFn: (value: 'private' | 'shared') => changeMemoryScope(session, memoryId, value),
    onSuccess: refresh,
    onError,
  });
  const reject = useMutation({
    mutationFn: () => rejectMemory(session, memoryId),
    onSuccess: async () => {
      await refresh();
      onClose(); // the memory no longer exists
    },
    onError,
  });
  const edit = useMutation({
    mutationFn: (content: string) => editMemory(session, memoryId, content),
    onSuccess: async (result) => {
      localStorage.setItem(EDIT_EXPLAINED_KEY, 'true');
      setEditing(false);
      await refresh();
      // Jump the drawer to the successor — that is the living memory now.
      onNavigate(result.successor.id);
    },
    onError,
  });

  const busy =
    approve.isPending ||
    outdate.isPending ||
    sensitive.isPending ||
    scope.isPending ||
    reject.isPending ||
    edit.isPending;

  return (
    <>
      <Drawer title={t('drawer.title')} onClose={onClose}>
        {memoryQuery.isPending && <SkeletonRows rows={4} label={t('drawer.loading')} />}
        {memoryQuery.isError && <ErrorState>{t('drawer.loadError')}</ErrorState>}

        {memory && (
          <>
            <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-base leading-relaxed text-slate-800">
              {memory.content}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <StatusChip status={memory.status} />
              {memory.sensitive && <SensitiveBadge />}
              {memory.scope === 'shared' ? <SharedBadge /> : <PrivateTag />}
              {!isMine && (
                <span className="text-slate-400">
                  {t('drawer.ownedBy', { owner: memory.ownerName ?? t('list.anotherMember') })}
                </span>
              )}
              {memory.entities.map((entity) => (
                <EntityChip
                  key={entity}
                  name={entity}
                  title={t('drawer.timeTravelEntity', { entity })}
                  onClick={() => {
                    window.location.href = timelineHref(entity);
                  }}
                />
              ))}
            </div>
            {(memory.validFrom || memory.validUntil) && (
              <p className="text-xs text-slate-400">
                {t('drawer.validity', {
                  from: memory.validFrom ? formatShortDate(memory.validFrom) : '…',
                  until: memory.validUntil
                    ? formatShortDate(memory.validUntil)
                    : t('drawer.validityOpen'),
                })}
              </p>
            )}
            {memory.temporalUnresolved.length > 0 && (
              <p className="rounded-md bg-amber-50 dark:bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
                {t('drawer.unresolvedDate', { phrases: memory.temporalUnresolved.join(', ') })}
              </p>
            )}

            {actionError && (
              <p className="rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                {actionError}
              </p>
            )}

            <Panel title={t('drawer.panel.actions')}>
              {!isMine ? (
                <p className="text-sm text-slate-500">
                  <Trans
                    i18nKey="drawer.sharedByOwner"
                    ns="memories"
                    values={{ owner: memory.ownerName ?? t('list.anotherMember') }}
                    components={{ owner: <span className="font-medium" /> }}
                  />
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {memory.status === 'uncertain' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => approve.mutate()}
                        className={btnPrimary}
                        title={t('drawer.confirmTitle')}
                      >
                        {t('drawer.confirm')}
                      </button>
                    )}
                    {memory.status === 'uncertain' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          void confirm({
                            title: t('drawer.rejectConfirm'),
                            confirmLabel: t('drawer.rejectAction'),
                            destructive: true,
                          }).then((asked) => {
                            if (asked) reject.mutate();
                          });
                        }}
                        className={btnDanger}
                      >
                        {t('drawer.reject')}
                      </button>
                    )}
                    {memory.status !== 'outdated' && memory.status !== 'replaced' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => outdate.mutate()}
                        className={btnSecondary}
                      >
                        {t('drawer.markOutdated')}
                      </button>
                    )}
                    {memory.status !== 'replaced' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setEditText(memory.content ?? '');
                          setEditing(true);
                        }}
                        className={btnSecondary}
                      >
                        {t('drawer.edit')}
                      </button>
                    )}
                    <label
                      className="ml-auto flex items-center gap-1.5 text-xs text-slate-600"
                      title={t('drawer.scopeTitle')}
                    >
                      {t('drawer.scope')}
                      <select
                        value={memory.scope}
                        disabled={busy}
                        onChange={(e) => scope.mutate(e.target.value as 'private' | 'shared')}
                        className="rounded-md border border-slate-300 px-2 py-0.5"
                      >
                        <option value="private">{t('common:memoryScope.private')}</option>
                        <option value="shared">{t('common:memoryScope.shared')}</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={memory.sensitive}
                        disabled={busy}
                        onChange={(e) => sensitive.mutate(e.target.checked)}
                      />
                      {t('drawer.sensitive')}
                    </label>
                  </div>
                  {editing && (
                    <form
                      className="mt-3 space-y-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (editText.trim()) edit.mutate(editText.trim());
                      }}
                    >
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={3}
                        className="w-full resize-y rounded-md border border-slate-300 p-2 text-sm"
                      />
                      {showExplainer && (
                        <p className="text-xs text-slate-500">{t('drawer.editExplainer')}</p>
                      )}
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={busy || !editText.trim()}
                          className={btnPrimary}
                        >
                          {t('drawer.saveCorrection')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(false)}
                          className={btnSecondary}
                        >
                          {t('common:action.cancel')}
                        </button>
                      </div>
                    </form>
                  )}
                </>
              )}
            </Panel>

            {memory.status === 'contradicted' && (
              <Panel title={t('drawer.panel.contradiction')}>
                {otherSide ? (
                  <div className="space-y-2 text-sm">
                    <p className="text-slate-600">{t('drawer.conflictsWith')}</p>
                    <p className="rounded-md bg-red-50 dark:bg-red-500/10 p-2 text-slate-800">
                      {otherSide.content}
                    </p>
                    {otherNoteQuery.data && (
                      <p className="whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-600">
                        {otherNoteQuery.data.content}
                      </p>
                    )}
                    <a href="/review" className={`${btnPrimary} no-underline`}>
                      {t('drawer.resolveInReview')}
                    </a>
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">
                    {contradictionsQuery.isPending
                      ? t('drawer.conflictLoading')
                      : t('drawer.conflictHidden')}
                  </p>
                )}
              </Panel>
            )}

            <Panel title={t('drawer.panel.verification')}>
              {memory.uncertaintyReason && (
                <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100">
                  <Trans
                    i18nKey={
                      memory.status === 'uncertain'
                        ? 'drawer.uncertainty.held'
                        : 'drawer.uncertainty.wasAdmitted'
                    }
                    ns="memories"
                    values={{
                      reason: t(`uncertaintyReason.${memory.uncertaintyReason}`),
                    }}
                    components={{ lead: <span className="font-medium" /> }}
                  />
                </p>
              )}
              {verificationQuery.data ? (
                <div className="space-y-1 text-sm">
                  <p className="flex items-center gap-2">
                    <VerdictChip verdict={verificationQuery.data.verdict} />
                    <span className="text-xs text-slate-400">
                      {verificationQuery.data.promptVersion}
                    </span>
                  </p>
                  <p className="text-slate-600">{verificationQuery.data.reason}</p>
                  {verificationQuery.data.hedgePhrase && (
                    <p className="text-xs text-amber-800 dark:text-amber-300">
                      {t('drawer.hedgePhrase', { phrase: verificationQuery.data.hedgePhrase })}
                    </p>
                  )}
                  {verificationQuery.data.sourceSpan && (
                    <p className="rounded bg-slate-50 p-2 text-xs italic text-slate-500">
                      {t('drawer.citedSpan', { span: verificationQuery.data.sourceSpan })}
                    </p>
                  )}
                  {verificationQuery.data.spanLocators ? (
                    <LocatorChips locators={verificationQuery.data.spanLocators} />
                  ) : (
                    verificationQuery.data.sourceSpan &&
                    memory.sourceType === 'file' && (
                      <p className="text-[0.68rem] text-slate-400">
                        {t('sources:detail.noLocation')}
                      </p>
                    )
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-400">{t('drawer.noVerification')}</p>
              )}
            </Panel>

            <Panel title={t('drawer.panel.relations')}>
              {relationsQuery.data && relationsQuery.data.length > 0 ? (
                <ul className="space-y-2">
                  {relationsQuery.data.map((item) => (
                    <li
                      key={item.relationId}
                      className="rounded-md border border-slate-200 p-2 text-sm"
                    >
                      <button
                        type="button"
                        onClick={() => onNavigate(item.other.id)}
                        className="w-full text-left text-slate-700 underline-offset-2 hover:underline"
                      >
                        {item.other.content ?? t('drawer.relationCounterpart')}
                      </button>
                      <p className="mt-1 text-xs text-slate-400">
                        {item.resolvedAt
                          ? t('drawer.relationResolved', {
                              when: timeAgo(item.detectedAt),
                              resolution: relationResolutionLabel(t, item.resolution),
                            })
                          : t('drawer.relationOpen', { when: timeAgo(item.detectedAt) })}
                      </p>
                      {item.detectedBy && (
                        <p className="mt-0.5 text-[0.68rem] text-slate-400">
                          {t(`drawer.detectedBy.${item.detectedBy}`, {
                            defaultValue: item.detectedBy,
                          })}
                        </p>
                      )}
                      {item.events.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5 border-t border-slate-100 pt-1.5">
                          {item.events.map((event, index) => (
                            <li key={index} className="text-[0.68rem] text-slate-400">
                              {t(`drawer.event.${event.event}`, { defaultValue: event.event })}
                              <span className="ml-1.5" title={event.createdAt}>
                                {timeAgo(event.createdAt)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-400">{t('drawer.noRelations')}</p>
              )}
            </Panel>

            <Panel title={t('drawer.panel.citedBy')}>
              {citingQuery.data && citingQuery.data.length > 0 ? (
                <ul className="space-y-1.5">
                  {citingQuery.data.map((answer) => (
                    <li key={answer.messageId} className="text-sm">
                      <a
                        href={`/chat?c=${encodeURIComponent(answer.conversationId)}&m=${encodeURIComponent(answer.messageId)}`}
                        className="text-slate-700 underline underline-offset-2 hover:text-slate-900"
                      >
                        {answer.conversationTitle ?? t('drawer.untitledConversation')}
                      </a>
                      <span className="ml-2 text-xs text-slate-400" title={answer.createdAt}>
                        {timeAgo(answer.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-400">{t('drawer.noCitations')}</p>
              )}
            </Panel>

            <Panel title={t('drawer.panel.provenance')}>
              <p className="text-sm text-slate-600">
                <Trans
                  i18nKey="drawer.source"
                  ns="memories"
                  values={{
                    kind: t(`sources:kindLabel.${memory.sourceType}`, {
                      defaultValue: memory.sourceType.replace('_', ' '),
                    }),
                  }}
                  components={{ kind: <span className="font-medium" /> }}
                />
                <span className="ml-2 text-xs text-slate-400" title={memory.createdAt}>
                  {t('drawer.captured', { when: timeAgo(memory.createdAt) })}
                </span>
              </p>
              {noteQuery.data && (
                <p className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-600">
                  {noteQuery.data.content}
                </p>
              )}
              {isMine ? (
                <button
                  type="button"
                  onClick={() => setShowSource(true)}
                  className={`${btnSecondary} mt-2`}
                >
                  {t('drawer.openSource')}
                </button>
              ) : (
                <p className="mt-2 text-xs text-slate-400">{t('drawer.sourceOwnerOnly')}</p>
              )}
            </Panel>

            <Panel title={t('drawer.panel.history')}>
              {memory.entities.length > 0 && (
                <a
                  href={timelineHref(memory.entities[0]!, memory.validFrom ?? memory.createdAt)}
                  className={`${btnSecondary} mb-2`}
                >
                  {t('drawer.openTimeline', { entity: memory.entities[0] })}
                </a>
              )}
              {chainQuery.data && chainQuery.data.length > 1 ? (
                <ol className="space-y-2">
                  {chainQuery.data.map((entry, i) => (
                    <li
                      key={entry.id}
                      className={`rounded-md border p-2 text-sm ${
                        entry.id === memory.id ? 'border-brand-teal/50' : 'border-slate-200'
                      }`}
                    >
                      <p className="whitespace-pre-wrap text-slate-700">{entry.content}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                        <StatusChip status={entry.status} />
                        <span title={entry.createdAt}>
                          {t('drawer.chainEntry', {
                            kind: i === 0 ? t('drawer.original') : t('drawer.correction'),
                            when: timeAgo(entry.createdAt),
                          })}
                        </span>
                        {entry.id === memory.id && (
                          <span className="font-semibold text-brand-teal-ink dark:text-brand-teal">
                            {t('drawer.viewing')}
                          </span>
                        )}
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-slate-400">{t('drawer.noCorrections')}</p>
              )}
            </Panel>
          </>
        )}
      </Drawer>
      {memory && showSource && (
        <SourceDrawer
          session={session}
          sourceType={memory.sourceType}
          sourceId={memory.sourceId}
          onOpenMemory={(id) => {
            setShowSource(false);
            onNavigate(id);
          }}
          onClose={() => setShowSource(false)}
          onDeleted={() => {
            // The source, this memory and its siblings are gone; a signed
            // receipt is being confirmed by the worker (Forgotten UI:).
            setShowSource(false);
            onClose();
          }}
        />
      )}
    </>
  );
}
