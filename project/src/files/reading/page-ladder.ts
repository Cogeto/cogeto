import { Logger } from '@nestjs/common';
import { VisionUnavailableError } from '../../model-gateway/index';
import type { ModelGateway } from '../../model-gateway/index';
import { decideNextStep } from './ladder';
import type { LadderLimits, PageOutcome, PageSignals, PageUnreadReason, ReadTier } from './ladder';
import { readImage } from './ocr';
import { measurePageInk, renderPagePng } from './rasterize';
import { scoreText } from './page-quality';
import type { TextQuality } from './page-quality';
import { readPageWithVision } from './vision-read';

/**
 * Running the ladder over one page (V2.1 item 4.1).
 *
 * `ladder.ts` decides, this executes: render, OCR, escalate. Keeping the two
 * apart is what lets every routing rule be tested without a binary or a model,
 * and it is why the decision function is consulted between steps rather than
 * once at the top.
 */

export interface PageLadderCaps {
  /** Vision escalations allowed for one document. */
  visionPagesPerDocument: number;
  /** Render resolution for OCR and vision. */
  readDpi?: number;
  ocrTimeoutMs?: number;
  rasterizeTimeoutMs?: number;
}

export interface PageLadderServices {
  /** Present when poppler is installed in this process. */
  rasterize: boolean;
  /** Present when tesseract and at least one language pack are installed. */
  ocr: boolean;
  /** The gateway, when a vision tier is configured AND probed working. */
  vision: ModelGateway | null;
  caps: PageLadderCaps;
}

export interface PageReadResult {
  text: string;
  outcome: PageOutcome;
  /** Filled in as the ladder learns about the page; recorded on the report. */
  signals: { textScore: number; ocrScore?: number; ink?: number; ocrConfidence?: number | null };
}

/** Mutable across one document: the caps are per document, not per page. */
export interface DocumentLadderState {
  visionPagesLeft: number;
  visionPagesUsed: number;
  /** Set once vision has failed, so page 2 does not repeat page 1's mistake. */
  visionFailure: string | null;
}

export function newDocumentState(caps: PageLadderCaps): DocumentLadderState {
  return { visionPagesLeft: caps.visionPagesPerDocument, visionPagesUsed: 0, visionFailure: null };
}

const logger = new Logger('reading.ladder');

/** A page that produced no text, with the reason it produced none. */
function unread(quality: TextQuality, reason: PageUnreadReason): PageReadResult {
  return { text: '', outcome: { read: false, reason }, signals: { textScore: quality.score } };
}

/**
 * Reads one page, cheapest tier first.
 *
 * `pdf` and `page` are needed because tiers two and three work from PIXELS: the
 * page has to be rendered before it can be read, and rendering is the caller's
 * bytes plus a page number.
 */
export async function readPage(
  pdf: Buffer,
  page: number,
  textLayer: string,
  services: PageLadderServices,
  state: DocumentLadderState,
): Promise<PageReadResult> {
  // Tier one costs nothing: no render, no process, no call. A page size is not
  // known yet, so the score falls back to its absolute character floor, which
  // is the conservative direction (a sparse page is examined, not discarded).
  const textQuality = scoreText(textLayer);
  const signals: PageSignals = { text: textQuality };
  const limits = (): LadderLimits => ({
    visionPagesLeft: state.visionFailure ? 0 : state.visionPagesLeft,
    visionAvailable: services.vision !== null && state.visionFailure === null,
    ocrAvailable: services.ocr && services.rasterize,
  });

  let decision = decideNextStep(signals, limits());
  if (decision.step === 'take_text') {
    return {
      text: textLayer,
      outcome: { read: true, tier: 'text' },
      signals: { textScore: textQuality.score },
    };
  }

  // Everything below needs pixels. Without a rasterizer there is nothing more
  // this process can do, and saying so is better than pretending the page read.
  if (!services.rasterize) {
    return unread(textQuality, 'needs_vision_unavailable');
  }

  // The ink measure comes first because it is the cheapest signal and it can
  // end the page: a blank sheet costs one low-resolution render and stops.
  let ink: number | null;
  let pageSize: { width: number; height: number } | null;
  try {
    const measured = await measurePageInk(pdf, page);
    ink = measured.fraction;
    pageSize = { width: measured.widthInches, height: measured.heightInches };
    signals.ink = ink;
  } catch (error) {
    // A page that cannot be rendered cannot be read by any tier below one.
    logger.warn(`page ${page}: could not measure ink (${describe(error)})`);
    return unread(textQuality, 'ocr_failed');
  }

  // With the page size known, re-score the text layer by DENSITY, which is the
  // measure that actually separates a scan's stray page number from a sparse
  // but real page.
  const denseQuality = scoreText(textLayer, pageSize);
  signals.text = denseQuality;
  decision = decideNextStep(signals, limits());
  if (decision.step === 'take_text') {
    return {
      text: textLayer,
      outcome: { read: true, tier: 'text' },
      signals: { textScore: denseQuality.score, ink: ink ?? undefined },
    };
  }

  let ocrQuality: TextQuality | null = null;
  let ocrText = '';
  let ocrConfidence: number | null = null;
  if (decision.step === 'run_ocr') {
    try {
      const rendered = await renderPagePng(pdf, page, {
        dpi: services.caps.readDpi,
        timeoutMs: services.caps.rasterizeTimeoutMs,
      });
      const result = await readImage(rendered.bytes, { timeoutMs: services.caps.ocrTimeoutMs });
      ocrText = result.text;
      ocrConfidence = result.meanConfidence;
      ocrQuality = scoreText(ocrText, pageSize);
    } catch (error) {
      logger.warn(`page ${page}: OCR failed (${describe(error)})`);
      ocrQuality = scoreText('', pageSize);
    }
    signals.ocr = ocrQuality;
    decision = decideNextStep(signals, limits());
    if (decision.step === 'take_text') {
      return {
        text: ocrText,
        outcome: { read: true, tier: 'ocr' },
        signals: {
          textScore: denseQuality.score,
          ocrScore: ocrQuality.score,
          ink: ink ?? undefined,
          ocrConfidence,
        },
      };
    }
  } else {
    // OCR is unavailable in this process; record that it did not run.
    signals.ocr = null;
    decision = decideNextStep(signals, limits());
  }

  const partial = {
    textScore: denseQuality.score,
    ...(ocrQuality ? { ocrScore: ocrQuality.score, ocrConfidence } : {}),
    ink: ink ?? undefined,
  };

  if (decision.step !== 'run_vision') {
    return {
      text: '',
      outcome: { read: false, reason: decision.reason ?? 'blank' },
      signals: partial,
    };
  }

  const gateway = services.vision;
  if (!gateway) {
    return {
      text: '',
      outcome: { read: false, reason: 'needs_vision_unavailable' },
      signals: partial,
    };
  }
  try {
    const rendered = await renderPagePng(pdf, page, {
      dpi: services.caps.readDpi,
      timeoutMs: services.caps.rasterizeTimeoutMs,
    });
    const result = await readPageWithVision(gateway, rendered, { page });
    state.visionPagesLeft -= 1;
    state.visionPagesUsed += 1;
    if (result.nothingReadable) {
      return { text: '', outcome: { read: false, reason: 'blank' }, signals: partial };
    }
    return { text: result.text, outcome: { read: true, tier: 'vision' }, signals: partial };
  } catch (error) {
    // One failure ends vision for the whole document. Twenty pages each
    // discovering the same unloaded projector is twenty pointless minutes, and
    // the honest label is identical for all of them.
    state.visionFailure = describe(error);
    const reason =
      error instanceof VisionUnavailableError ? 'needs_vision_unavailable' : 'vision_failed';
    logger.warn(
      `page ${page}: vision failed, not retried for this document (${state.visionFailure})`,
    );
    return { text: '', outcome: { read: false, reason }, signals: partial };
  }
}

export const tierOf = (outcome: PageOutcome): ReadTier | null =>
  outcome.read ? outcome.tier : null;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
