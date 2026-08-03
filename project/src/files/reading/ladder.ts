import { isUsable, scoreText } from './page-quality';
import type { TextQuality } from './page-quality';

/**
 * The reading ladder's routing decision (V2.1 item 4.1).
 *
 * Deterministic, cheapest-first, decided per page, and costing NO model call to
 * decide. That last property is the reason this file is pure arithmetic over
 * numbers the caller already has: asking a model which tier to use would spend
 * the expensive resource on the decision about whether to spend the expensive
 * resource.
 *
 * The order is fixed and each step is only taken when the one before it failed:
 *
 *   1. `text`   the page's own text layer, when it is usable (see page-quality)
 *   2. `ocr`    local Tesseract, CPU-only, in-instance, nothing leaves the box
 *   3. `vision` a model that can see, only for pages OCR could not read and for
 *               pages that are pictures rather than text
 *
 * and a page that reaches the end unread is recorded as unread with the reason,
 * never as an empty success.
 */

export type ReadTier = 'text' | 'ocr' | 'vision';

/** Why a page ended where it did. Stored on the read report, shown in Sources. */
export type PageOutcome =
  { read: true; tier: ReadTier } | { read: false; reason: PageUnreadReason };

/**
 * The reasons a page ends unread. Each is a different fact about the world and
 * leads somewhere different: enable a capability, raise a cap, or accept that
 * the page has nothing on it.
 */
export type PageUnreadReason =
  | 'blank'
  | 'ocr_failed'
  | 'needs_vision_unavailable'
  | 'needs_vision_cap_reached'
  | 'vision_failed';

export interface PageSignals {
  /** Quality of the page's own text layer. */
  text: TextQuality;
  /** Quality of the OCR output, when OCR ran. */
  ocr?: TextQuality | null;
  /**
   * Share of the rendered page that is not blank paper, 0..1. Present when the
   * page was rendered. This is what distinguishes "an empty page" from "a
   * schematic": both have no text, and only one is worth a vision call.
   */
  ink?: number | null;
}

export interface LadderLimits {
  /** Vision escalations still allowed for this document. */
  visionPagesLeft: number;
  /** Whether the instance can call vision at all right now. */
  visionAvailable: boolean;
  /** Whether OCR is available in this process (the binary is present). */
  ocrAvailable: boolean;
}

/**
 * Ink coverage at or above which a page with no readable text is worth reading
 * rather than being blank paper.
 *
 * MEASURED, not guessed. Rendered at 25 DPI, counting everything darker than
 * near-white:
 *
 *   a blank page                     0.000
 *   one line of text, vector PDF     0.012
 *   one line of text, scanned JPEG   0.010
 *
 * The first value here was 2%, reasoned from "a diagram covers whole percents",
 * and it was wrong: a page carrying a single line of real text measures about
 * one percent, so that threshold would have discarded pages that plainly have
 * content on them. 0.3% sits an order of magnitude below the one-line
 * measurement and comfortably above what a real scan of blank paper produces,
 * which is not zero (paper texture and JPEG ringing leave a few tenths of a
 * percent on an empty sheet) but is well under this.
 *
 * The direction of the error matters: too low wastes a vision call on a blank
 * page, too high silently drops a page that had something on it. The second is
 * the failure this item exists to remove, so the threshold leans low.
 */
export const PICTURE_INK_FRACTION = 0.003;

/**
 * Decides where a page's text comes from, given what is known about it.
 *
 * Called once per stage rather than once per page: the caller consults it,
 * performs the step it names, and consults it again with the new signal. That
 * keeps the expensive work outside a pure function and makes every branch
 * testable without a binary or a model.
 */
export function decideNextStep(
  signals: PageSignals,
  limits: LadderLimits,
): { step: 'take_text' | 'run_ocr' | 'run_vision' | 'give_up'; reason?: PageUnreadReason } {
  // 1. A usable text layer wins, always. Nothing is rendered, nothing is
  //    called, and the page costs nothing.
  if (isUsable(signals.text)) return { step: 'take_text' };

  // 2. OCR, if it has not run yet.
  if (signals.ocr === undefined) {
    if (limits.ocrAvailable) return { step: 'run_ocr' };
    return escalate(signals, limits);
  }

  // 3. OCR ran and produced usable text.
  if (signals.ocr && isUsable(signals.ocr)) return { step: 'take_text' };

  return escalate(signals, limits);
}

/**
 * The escalation decision, reached when nothing cheaper produced usable text.
 *
 * A page only escalates if there is something on it to read. That is the ink
 * measure's whole job: without it, a hundred blank separator pages in a scanned
 * bundle would each cost a vision call, and the caps would be spent on paper.
 */
function escalate(
  signals: PageSignals,
  limits: LadderLimits,
): { step: 'run_vision' | 'give_up'; reason?: PageUnreadReason } {
  const hasInkSignal = signals.ink !== undefined && signals.ink !== null;
  const isPicture = hasInkSignal && signals.ink! >= PICTURE_INK_FRACTION;
  // With no ink measurement at all (a standalone image upload, where the whole
  // file IS the picture) the page is assumed worth reading.
  const worthReading = !hasInkSignal || isPicture;

  if (!worthReading) return { step: 'give_up', reason: 'blank' };
  if (!limits.visionAvailable) return { step: 'give_up', reason: 'needs_vision_unavailable' };
  if (limits.visionPagesLeft <= 0) return { step: 'give_up', reason: 'needs_vision_cap_reached' };
  return { step: 'run_vision' };
}

/** Convenience for the readers: score, then decide, in one call. */
export function scorePage(
  text: string,
  page?: { width: number; height: number } | null,
): TextQuality {
  return scoreText(text, page);
}
