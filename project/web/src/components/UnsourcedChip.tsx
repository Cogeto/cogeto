/**
 * The unsourced-claim affordance: renders the canonical
 * `{{unsourced}}` marker after a claim from the model's own general knowledge.
 * Deliberately calm — the marking is a feature, not a warning: it is how the
 * user always knows which parts of an answer Cogeto can prove and which parts
 * are the model talking. Distinct from every citation chip (no ordinal, no
 * status color) so it can never be mistaken for a source.
 *
 * Two shapes (issue #581), because it has to work as a reference and as an
 * entry:
 *
 * - `inline` is the badge inside the sentence: SHORT, one glyph and one word,
 *   and NEVER part of a text selection. A marker that copies into the
 *   clipboard turns provenance into noise the moment anyone quotes an answer,
 *   which is the same reason the citation chips are unselectable.
 * - `entry` is the row under the answer, beside the cited documents: it says
 *   in full what the badge stands for, so the badge never has to.
 */
import { useTranslation } from 'react-i18next';

export function UnsourcedChip({ variant = 'inline' }: { variant?: 'inline' | 'entry' }) {
  const { t } = useTranslation('chat');
  if (variant === 'entry') {
    return (
      <div className="flex items-baseline gap-2 text-xs text-slate-500">
        <span
          aria-hidden="true"
          className="select-none rounded border border-amber-400/40 bg-amber-50 px-1 font-mono text-[0.62rem] font-medium text-amber-700 dark:bg-amber-400/10 dark:text-amber-300"
        >
          ◆
        </span>
        <span>{t('citation.unsourced.entry')}</span>
      </div>
    );
  }
  return (
    <span
      // select-none: the badge is provenance, not prose. Dragging across an
      // answer must yield the sentence, not the sentence plus "model".
      className="mx-0.5 inline-flex select-none items-center gap-0.5 rounded border border-amber-400/40 bg-amber-50 px-1 align-baseline font-mono text-[0.68rem] font-medium text-amber-700 dark:bg-amber-400/10 dark:text-amber-300"
      title={t('citation.unsourced.title')}
      aria-label={t('citation.unsourced.ariaLabel')}
    >
      <span aria-hidden="true">◆</span>
      {t('citation.unsourced.label')}
    </span>
  );
}
