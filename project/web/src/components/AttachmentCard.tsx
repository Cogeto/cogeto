import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ChatAttachmentDto } from '@cogeto/shared';
import { fetchChatAttachment } from '../api';
import type { Session } from '../auth/oidc';
import { formatFileSize } from '../i18n/format';

/**
 * Read outcomes that mean the document produced NO text (V2.1 item 4.1) —
 * the same rule the Sources pending row applies: a settled job is not a read.
 */
const UNREAD_OUTCOMES = ['needs_vision', 'empty', 'read_failed', 'unsupported_format'];

/**
 * One attached file's card in the conversation (V2.2 item 5.1): a first-class,
 * persistent element of the thread, never a toast. While the pipeline runs it
 * shows the honest stage the pipeline actually reports; settled, it shows the
 * real numbers (facts, contradictions), the gate's refusal when there was one,
 * or the reading layer's reason when nothing could be read — and it links to
 * the source on Sources. A transient attachment says plainly what transient
 * means: read once for this conversation, bytes discarded, never a source.
 */
export function AttachmentCard({
  session,
  attachment,
}: {
  session: Session;
  attachment: ChatAttachmentDto;
}) {
  const { t } = useTranslation('chat');
  const queryClient = useQueryClient();

  // Poll while the pipeline (or the transient read) is still running; the
  // settled DTO is stamped server-side, so once done the card stops asking.
  const { data } = useQuery({
    queryKey: ['chat-attachment', attachment.id],
    queryFn: () => fetchChatAttachment(session, attachment.id),
    initialData: attachment,
    refetchInterval: (query) => (query.state.data?.state === 'processing' ? 1500 : false),
  });
  const current = data ?? attachment;
  const processing = current.state === 'processing';

  // Once a durable ingestion settles, the facts exist: refresh the surfaces
  // that show them (the memories list, the conversation's attachment list).
  useEffect(() => {
    if (processing || attachment.state !== 'processing') return;
    void queryClient.invalidateQueries({ queryKey: ['memories'] });
    void queryClient.invalidateQueries({
      queryKey: ['chat-attachments', current.conversationId],
    });
  }, [processing, attachment.state, current.conversationId, queryClient]);

  const failed = current.state === 'error';
  const unread =
    current.readOutcome !== null && UNREAD_OUTCOMES.includes(current.readOutcome as string);
  const refused = current.gateRefusal !== null;
  const settledOk = current.state === 'done' && !current.transient && !unread && !refused;

  const tone = failed
    ? 'border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10'
    : unread || refused
      ? 'border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10'
      : 'border-slate-200 bg-surface';

  return (
    <div className={`mt-2 space-y-1 rounded-lg border px-3 py-2 text-sm ${tone}`}>
      <div className="flex items-center gap-2">
        <PaperclipGlyph />
        <span className="truncate font-medium text-slate-700">
          {current.sourceDeleted || current.name === null
            ? t('attachment.sourceRemoved')
            : current.name}
        </span>
        {current.sizeBytes !== null && (
          <span className="shrink-0 text-xs text-slate-400">
            {formatFileSize(current.sizeBytes)}
          </span>
        )}
        {current.transient && (
          <span className="shrink-0 rounded-full border border-slate-300 px-2 py-0.5 font-mono text-[0.62rem] tracking-[0.04em] text-slate-500">
            {t('attachment.transientChip')}
          </span>
        )}
        {processing && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-500">
            <span className="h-2 w-2 animate-pulse rounded-full bg-brand-teal" aria-hidden="true" />
            {t(`attachment.stage.${current.stage ?? 'queued'}`)}
          </span>
        )}
      </div>

      {failed && (
        <p className="text-xs text-red-700 dark:text-red-300">
          {t('attachment.failed')}
          {current.readReason && (
            <> {t(`sources:read.reason.${current.readReason}`, { defaultValue: '' })}</>
          )}
        </p>
      )}

      {!failed && !processing && current.transient && (
        <p className="text-xs text-slate-500">{t('attachment.transientReady')}</p>
      )}

      {!failed && !processing && !current.transient && refused && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          {t('attachment.gateRefused', {
            reason: t(`extraction:refusalReason.${current.gateRefusal}`, {
              defaultValue: current.gateRefusal ?? '',
            }),
          })}
        </p>
      )}

      {!failed && !processing && !current.transient && !refused && unread && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          {t(`sources:read.outcome.${current.readOutcome}`, { defaultValue: '' })}
          {current.readReason && (
            <> {t(`sources:read.reason.${current.readReason}`, { defaultValue: '' })}</>
          )}
        </p>
      )}

      {settledOk && !current.sourceDeleted && (
        <p className="text-xs text-slate-600">
          {t('attachment.addedToSources', {
            facts: t('attachment.factsCount', { count: current.factsCount ?? 0 }),
            contradictions: t('attachment.contradictionsCount', {
              count: current.contradictionsCount ?? 0,
            }),
          })}
          {current.readOutcome === 'truncated' && <> {t('attachment.truncatedNote')}</>}
          {current.objectKey && (
            <>
              {' '}
              <a
                href={`/sources?open=${encodeURIComponent(current.objectKey)}`}
                className="font-semibold underline underline-offset-2"
              >
                {t('attachment.viewInSources')}
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * The one-line honesty note under the composer's pending attachment: what
 * "don't remember this file" actually keeps and costs.
 */
export function TransientMeaningLine() {
  const { t } = useTranslation('chat');
  return (
    <p className="text-xs leading-relaxed text-slate-400">{t('attachment.transientMeaning')}</p>
  );
}

function PaperclipGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true">
      <path
        d="M13.8 8.2 8.9 13.1a2.4 2.4 0 0 1-3.4-3.4l5.6-5.6a3.6 3.6 0 0 1 5.1 5.1l-6 6a4.8 4.8 0 0 1-6.8-6.8l5.3-5.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
