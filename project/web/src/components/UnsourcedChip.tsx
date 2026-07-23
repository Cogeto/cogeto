/**
 * The unsourced-claim affordance (decision 0046): renders the canonical
 * `{{unsourced}}` marker after a claim from the model's own general knowledge.
 * Deliberately calm — the marking is a feature, not a warning: it is how the
 * user always knows which parts of an answer Cogeto can prove and which parts
 * are the model talking. Distinct from every citation chip (no ordinal, no
 * status color) so it can never be mistaken for a source.
 */
export function UnsourcedChip() {
  return (
    <span
      className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-amber-400/40 bg-amber-50 px-1.5 align-baseline font-mono text-[0.72rem] font-medium text-amber-700 dark:bg-amber-400/10 dark:text-amber-300"
      title="Model knowledge, not from your sources. Cogeto marks these so you always know which claims it can prove."
      aria-label="model knowledge, not from your sources"
    >
      <span aria-hidden="true">◆</span>unsourced
    </span>
  );
}
