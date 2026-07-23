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
      className="mx-0.5 inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-1.5 align-baseline text-xs font-medium text-slate-400"
      title="Model knowledge, not from your sources. Cogeto marks these so you always know which claims it can prove."
      aria-label="model knowledge, not from your sources"
    >
      unsourced
    </span>
  );
}
