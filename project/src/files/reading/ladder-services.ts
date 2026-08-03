import { Logger } from '@nestjs/common';
import type { ParseCaps } from '../../infrastructure/index';
import type { ModelGateway } from '../../model-gateway/index';
import { ocrAvailable } from './ocr';
import { rasterizerAvailable } from './rasterize';
import type { PageLadderServices } from './page-ladder';

/**
 * Assembling the reading ladder for one document (V2.1 item 4.1).
 *
 * Three questions, answered once per read rather than once per page:
 *
 * 1. **Are the local tools here?** Probed, not assumed. They ship in the
 *    runtime image, but the eval harness, a developer machine and a trimmed
 *    image are all real environments, and a missing binary must degrade the
 *    ladder rather than fail the document.
 * 2. **Is vision usable right now?** The caller supplies the gateway only when
 *    the capability probe says the configuration actually reads images. A tier
 *    that is configured but broken is not vision, and pretending otherwise
 *    turns every page into a slow failure.
 * 3. **How many pages may this document, and this user today, escalate?** Image
 *    inference is the most expensive call in the product; the caps are the
 *    thing that bounds it by construction rather than by hope.
 */

const logger = new Logger('reading.ladder');

/** Cached per process: a binary does not appear or vanish at runtime. */
let localTiers: Promise<{ rasterize: boolean; ocr: boolean }> | null = null;

export function probeLocalTiers(): Promise<{ rasterize: boolean; ocr: boolean }> {
  localTiers ??= (async () => {
    const [rasterize, ocr] = await Promise.all([rasterizerAvailable(), ocrAvailable()]);
    if (!rasterize) {
      logger.warn(
        'pdftoppm is not available: pages that are pictures cannot be rendered, so they will be ' +
          'reported as unreadable rather than read',
      );
    } else if (!ocr) {
      logger.warn('tesseract is not available: the ladder will skip local OCR');
    }
    return { rasterize, ocr };
  })();
  return localTiers;
}

/** Test seam: forget what was probed. */
export function resetLocalTierCache(): void {
  localTiers = null;
}

export interface LadderBudget {
  /** Vision pages this user has already spent today. */
  usedToday: number;
}

/**
 * Builds the services for one document.
 *
 * The per-document cap is the smaller of the configured document cap and what
 * the user has left for the day, so a user near their daily ceiling gets a
 * partial read that says so rather than a document that silently ignores the
 * daily cap.
 */
export async function buildLadderServices(options: {
  caps: ParseCaps;
  /** Present only when vision is configured AND probed working. */
  vision: ModelGateway | null;
  budget?: LadderBudget;
}): Promise<PageLadderServices> {
  const { rasterize, ocr } = await probeLocalTiers();
  const dailyLeft = options.budget
    ? Math.max(0, options.caps.visionPagesPerUserDaily - options.budget.usedToday)
    : options.caps.visionPagesPerDocument;
  return {
    rasterize,
    ocr,
    vision: options.vision,
    caps: {
      visionPagesPerDocument: Math.min(options.caps.visionPagesPerDocument, dailyLeft),
      ocrTimeoutMs: options.caps.timeoutSeconds * 1000,
      rasterizeTimeoutMs: options.caps.timeoutSeconds * 1000,
    },
  };
}
