/**
 * The unsourced-claim affordance: renders the canonical
 * `{{unsourced}}` marker after a claim from the model's own general knowledge.
 * Deliberately calm — the marking is a feature, not a warning: it is how the
 * user always knows which parts of an answer Cogeto can prove and which parts
 * are the model talking. Distinct from every citation chip (no ordinal, no
 * status color) so it can never be mistaken for a source.
 */
import { useTranslation } from 'react-i18next';

export function UnsourcedChip() {
  const { t } = useTranslation('chat');
  return (
    <span
      className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-amber-400/40 bg-amber-50 px-1.5 align-baseline font-mono text-[0.72rem] font-medium text-amber-700 dark:bg-amber-400/10 dark:text-amber-300"
      title={t('citation.unsourced.title')}
      aria-label={t('citation.unsourced.ariaLabel')}
    >
      <span aria-hidden="true">◆</span>
      {t('citation.unsourced.label')}
    </span>
  );
}
