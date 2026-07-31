import { UNCERTAINTY_REASONS } from '@cogeto/shared';
import type { UncertaintyReason } from '@cogeto/shared';
import type { CandidateFact } from './candidate-fact';
import type { VerificationVerdict } from '../persistence/tables';

/**
 * The admission taxonomy (V2.0 item 3.3): Cogeto resolves its own reviews.
 *
 * Nothing here waits for a person. Every extracted fact lands in exactly one
 * place — active, uncertain with a named sub-reason, or not admitted — and both
 * sides of the admission line write a suppressed-fact log entry, so a fact that
 * is not stored is still recoverable and explainable.
 *
 * The pure half lives here so the mapping is exhaustively testable without a
 * database, a model, or a container. The acting half (embed-store, the pipeline)
 * only executes what these decide.
 */

/** The signals the classifier reads. All of them are produced today. */
export interface AdmissionSignals {
  /** The verifier's verdict; the batch path's omission is `judged: false`. */
  verdict: VerificationVerdict;
  /**
   * False when the batched verifier's reply carried no verdict for this claim.
   * The pipeline still stores `unsupported` as the conservative verdict, but the
   * DECISION is that support could not be determined, which is a different fact
   * about the extraction and is reported as such.
   */
  judged: boolean;
  /** The extractor flagged the source's own wording as tentative. */
  hedged: boolean;
  /**
   * Whether the cited span was found verbatim in the source text the verifier
   * was given. When it was not, the verifier judged the claim against a fallback
   * window, so a negative verdict is not attributable to the cited evidence.
   */
  spanLocatable: boolean;
}

export interface AdmissionDecision {
  status: 'active' | 'uncertain';
  /** NULL exactly when the status is `active`. */
  reason: UncertaintyReason | null;
}

/**
 * The total mapping from a verification outcome to an admission. First match
 * wins; there is no default arm and no outcome falls through.
 *
 *   1. no verdict returned for the claim         → uncertain / unjudgeable
 *   2. supported + hedged                        → uncertain / hedged_in_source
 *   3. supported                                 → ACTIVE
 *   4. partial,     span not locatable           → uncertain / unjudgeable
 *      partial                                   → uncertain / partially_supported
 *   5. unsupported, span not locatable           → uncertain / unjudgeable
 *      unsupported                               → uncertain / unsupported
 *
 * Two deliberate precedence rules:
 *
 * - **Verifier failure outranks hedging.** `hedged_in_source` therefore means
 *   exactly "the only thing wrong is that the source was tentative", which is
 *   what makes it useful in the findings report.
 * - **Span locatability is consulted only on a non-`supported` verdict.** A
 *   supported claim whose span the chunker could not match is still admitted
 *   active, exactly as before this taxonomy existed. Admission is byte-identical
 *   to the previous rule (`!hedged && verdict === 'supported'` → active), so
 *   labelling cannot move an eval metric.
 */
export function classifyAdmission(signals: AdmissionSignals): AdmissionDecision {
  const { verdict, judged, hedged, spanLocatable } = signals;
  if (!judged) return { status: 'uncertain', reason: 'unjudgeable' };
  if (verdict === 'supported') {
    return hedged
      ? { status: 'uncertain', reason: 'hedged_in_source' }
      : { status: 'active', reason: null };
  }
  if (!spanLocatable) return { status: 'uncertain', reason: 'unjudgeable' };
  return {
    status: 'uncertain',
    reason: verdict === 'partial' ? 'partially_supported' : 'unsupported',
  };
}

/**
 * The one narrow non-admission case: storing this would be actively wrong
 * rather than merely uncertain.
 *
 * A blank claim is a memory row with no content; a blank span is a fact with no
 * provenance to inspect. Everything else — unsupported, partial, unjudgeable —
 * is ADMITTED as uncertain, because an admitted fact is inspectable in Sources
 * and citable with soft framing while a discarded one exists only in a log.
 *
 * Note what is deliberately NOT here: "the span is not in the source" is not a
 * structural-invalidity test. Chunking can split a legitimate span across
 * boundaries and whitespace can normalise, so treating an unmatched span as
 * fabrication would silently lose real facts. It lands `unjudgeable` instead.
 */
export function structurallyValid(fact: CandidateFact): boolean {
  return fact.claim.trim().length > 0 && fact.source_span.trim().length > 0;
}

/** Guard for readers of stored values: every reason is a KNOWN value. */
export function isUncertaintyReason(value: string): value is UncertaintyReason {
  return (UNCERTAINTY_REASONS as readonly string[]).includes(value);
}
