import { Inject, Injectable, Optional } from '@nestjs/common';
import { DailyCounters, DEFAULT_PARSE_CAPS, PARSE_CAPS } from '../infrastructure/index';
import type { ParseCaps } from '../infrastructure/index';
import type { ModelGateway } from '../model-gateway/index';
import { buildLadderServices } from './reading/ladder-services';
import type { ReadResult } from './reading/reader';
import { readDocument } from './reading/registry';

/**
 * How a composition root supplies the vision tier: a function, not a gateway,
 * because whether vision WORKS is a probed fact that can change while the
 * worker is running. Asking per document keeps a runtime that went away from
 * being discovered one page at a time.
 */
export abstract class VisionSource {
  abstract visionGateway(): Promise<ModelGateway | null>;
}

/** The daily-counter bucket vision pages are charged to. */
export const VISION_PAGE_BUCKET = 'vision_page';

/**
 * ONE laddered read for every caller (V2.2 item 5.1): bytes in, text plus
 * report out, through the full reading ladder — usable text layer, then local
 * OCR, then the probed vision tier — under the parse caps, with vision pages
 * charged to the owner's daily counter.
 *
 * Extracted from the file source reader so a transient chat attachment (which
 * never becomes a source and never enters the pipeline) is read by EXACTLY
 * the machinery a durable upload is: same formats, same caps, same honesty
 * about what could not be read. The reader seam's rule holds — this class
 * routes and meters; the registered readers decide.
 */
@Injectable()
export class LadderedDocumentReader {
  constructor(
    /** Parse caps; optional so a bare/test construction still works. */
    @Optional() @Inject(PARSE_CAPS) private readonly parseCaps: ParseCaps = DEFAULT_PARSE_CAPS,
    /** The vision tier, present only when configured AND probed working. */
    @Optional() private readonly visionGateway?: VisionSource,
    /** Per-user daily vision spend, for the second of the two caps. */
    @Optional() private readonly counters?: DailyCounters,
  ) {}

  /**
   * Reads the bytes through the ladder. Throws `PermanentExtractionError` for
   * an unreadable or unsupported document, exactly as the pipeline path does;
   * the caller decides how to record it.
   */
  async read(
    ownerId: string,
    bytes: Buffer,
    declaredContentType: string | null,
    filename: string | null,
  ): Promise<ReadResult> {
    const ladder = await buildLadderServices({
      caps: this.parseCaps,
      vision: (await this.visionGateway?.visionGateway()) ?? null,
      budget: this.counters
        ? { usedToday: await this.counters.get(ownerId, VISION_PAGE_BUCKET) }
        : undefined,
    });
    const result = await readDocument(bytes, {
      declaredContentType,
      filename,
      caps: this.parseCaps,
      ladder,
    });
    // Charge the day's vision spend to the owner the pages were read for.
    const spent = result.report.visionPagesUsed ?? 0;
    if (spent > 0 && this.counters) {
      await this.counters.add(ownerId, VISION_PAGE_BUCKET, spent, 'ingestion');
    }
    return result;
  }
}
