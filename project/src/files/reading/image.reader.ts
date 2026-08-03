import { IMAGE_CONTENT_TYPES } from '@cogeto/shared';
import { VisionUnavailableError } from '../../model-gateway/index';
import type { ReadSegment } from './locator';
import { isUsable, scoreText } from './page-quality';
import { readFailed } from './reader';
import type { DocumentReader, PageReadDetail, ReadInput, ReadResult } from './reader';
import { readImage } from './ocr';
import { readPageWithVision } from './vision-read';

/**
 * Standalone images (V2.1 item 4.1): a photograph of a page, a screenshot, an
 * exported diagram, a scanned receipt.
 *
 * These enter the ladder at tier TWO, not tier three. A standalone image has no
 * text layer to try, so tier one does not apply, but a screenshot of an invoice
 * is read perfectly by local OCR and sending it to a model would spend the most
 * expensive resource on the easiest case. The ladder's rule is cheapest-first,
 * and an image is not an exception to it: OCR runs, its output is scored by the
 * same measure as everywhere else, and only a poor score escalates.
 *
 * The practical effect for the cases that motivated this work is unchanged: a
 * schematic or a photograph produces little or no OCR text, scores poorly, and
 * escalates on the first try.
 */
export class ImageReader implements DocumentReader {
  readonly format = 'image' as const;
  readonly contentTypes = IMAGE_CONTENT_TYPES;
  readonly extensions = ['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'];
  readonly detectable = true;
  readonly input = 'bytes' as const;
  readonly granularity = 'page' as const;

  async read({ bytes, declaredContentType, ladder }: ReadInput): Promise<ReadResult> {
    const mediaType = declaredContentType ?? 'image/png';
    const pages: PageReadDetail[] = [];

    // Tier two: local OCR, in-instance, nothing leaves the box.
    let text = '';
    let tier: 'ocr' | 'vision' | null = null;
    let reason: string | null = null;
    let visionPagesUsed = 0;

    if (ladder?.ocr) {
      try {
        const result = await readImage(bytes, { timeoutMs: ladder.caps.ocrTimeoutMs });
        if (isUsable(scoreText(result.text))) {
          text = result.text;
          tier = 'ocr';
        }
      } catch {
        // An OCR failure is not the end: the picture may still be readable by a
        // model, and that is the next rung.
      }
    }

    // Tier three: a model that can see. There is no ink measure here, and none
    // is wanted: the file IS the picture, so "is there something on it" is
    // already answered by somebody having uploaded it.
    if (tier === null) {
      if (!ladder?.vision) {
        reason = 'needs_vision_unavailable';
      } else if (ladder.caps.visionPagesPerDocument <= 0) {
        reason = 'needs_vision_cap_reached';
      } else {
        try {
          const result = await readPageWithVision(ladder.vision, { bytes, mediaType });
          visionPagesUsed = 1;
          if (result.nothingReadable) reason = 'blank';
          else {
            text = result.text;
            tier = 'vision';
          }
        } catch (error) {
          reason =
            error instanceof VisionUnavailableError ? 'needs_vision_unavailable' : 'vision_failed';
        }
      }
    }

    pages.push({ page: 1, tier, reason });

    const segments: ReadSegment[] =
      text.length > 0
        ? [{ start: 0, end: text.length, locator: { kind: 'page', page: 1, tier: tier ?? 'text' } }]
        : [];

    return {
      text,
      segments,
      report: {
        format: 'image',
        granularity: 'page',
        outcome: outcomeFor(tier, reason),
        reasonCode: reasonCodeFor(tier, reason),
        segments: segments.length,
        sheets: [],
        valuesUnavailable: 0,
        unavailableCells: [],
        pages,
        visionPagesUsed,
      },
    };
  }
}

function outcomeFor(tier: string | null, reason: string | null): ReadResult['report']['outcome'] {
  if (tier !== null) return 'read';
  if (reason === 'needs_vision_unavailable' || reason === 'needs_vision_cap_reached') {
    return 'needs_vision';
  }
  if (reason === 'vision_failed') return 'read_failed';
  return 'empty';
}

function reasonCodeFor(
  tier: string | null,
  reason: string | null,
): ReadResult['report']['reasonCode'] {
  if (tier !== null) return null;
  switch (reason) {
    case 'needs_vision_unavailable':
      return 'vision_unavailable';
    case 'needs_vision_cap_reached':
      return 'vision_cap_reached';
    case 'vision_failed':
      return 'vision_failed';
    default:
      return 'no_readable_text';
  }
}

/** Kept for the failure path the registry's cap check uses. */
export const imageReadFailed = readFailed;
