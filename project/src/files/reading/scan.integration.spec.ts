import { describe, expect, it } from 'vitest';
import { PDF_CONTENT_TYPE } from '@cogeto/shared';
import { makeScannedPdf } from '../../testing/index';
import { ModelGateway } from '../../model-gateway/index';
import type { StreamDelta } from '../../model-gateway/index';
import type { CompletionResult, VisionRequest } from '../../model-gateway/index';
import { VisionUnavailableError } from '../../model-gateway/index';
import { ocrAvailable } from './ocr';
import { rasterizerAvailable } from './rasterize';
import { runBinary } from './run-binary';
import { readDocument } from './registry';
import type { PageLadderServices } from './page-ladder';

/**
 * The whole ladder, over a file that IS a picture (V2.1 item 4.1).
 *
 * The fixture is built the way a scan is made: a page of text rendered to
 * pixels and wrapped back into a PDF, so it has real glyphs and no text layer.
 * Before this work, that file reached the end of the pipeline as
 * done-with-zero-facts, which is the dishonesty being removed here.
 *
 * Needs `pdftoppm` and `tesseract`, which the runtime image installs; the block
 * skips itself where they are absent rather than failing for an environment
 * reason.
 */

const hasTools = (await rasterizerAvailable()) && (await ocrAvailable());

const SENTENCE = 'The supplier shall deliver the goods within thirty days of the order date.';

/** Renders page 1 to a JPEG, which is what makes the fixture a real scan. */
async function renderJpeg(pdf: Buffer): Promise<Buffer> {
  const result = await runBinary('pdftoppm', ['-jpeg', '-r', '150', '-f', '1', '-l', '1', '-'], {
    input: pdf,
    timeoutMs: 60_000,
    maxOutputBytes: 32 << 20,
  });
  if (result.code !== 0) throw new Error(`pdftoppm exited ${result.code}: ${result.stderr}`);
  return result.stdout;
}

const scannedPage = (junkTextLayer?: string) =>
  makeScannedPdf(SENTENCE, { renderJpeg, ...(junkTextLayer ? { junkTextLayer } : {}) });

class ScriptedVision extends ModelGateway {
  calls = 0;
  constructor(private readonly answer: () => CompletionResult) {
    super();
  }
  complete(): never {
    throw new Error('unused');
  }
  // eslint-disable-next-line require-yield -- unused here
  async *completeStream(): AsyncIterable<StreamDelta> {
    throw new Error('unused');
  }
  extractStructured(): never {
    throw new Error('unused');
  }
  async embed(): Promise<number[][]> {
    return [];
  }
  embeddingModelId(): string {
    return 'stub';
  }
  override async describeImage(_request: VisionRequest): Promise<CompletionResult> {
    this.calls += 1;
    return this.answer();
  }
}

const ladder = (overrides: Partial<PageLadderServices> = {}): PageLadderServices => ({
  rasterize: true,
  ocr: true,
  vision: null,
  caps: { visionPagesPerDocument: 5 },
  ...overrides,
});

describe.skipIf(!hasTools)('a scanned page, through the ladder', () => {
  it('is read by local OCR, and the provenance says so', async () => {
    const scan = await scannedPage();
    const result = await readDocument(scan, {
      declaredContentType: PDF_CONTENT_TYPE,
      ladder: ladder(),
    });

    expect(result.text.toLowerCase()).toContain('supplier');
    expect(result.report.outcome).toBe('read');
    expect(result.report.pages).toEqual([{ page: 1, tier: 'ocr', reason: null }]);
    // The tier travels with the locator, so a surface can show that this fact
    // was read off pixels rather than lifted from a text layer.
    expect(result.segments[0]?.locator).toMatchObject({ kind: 'page', page: 1, tier: 'ocr' });
    // Nothing was sent anywhere: OCR is local and it was enough.
    expect(result.report.visionPagesUsed).toBe(0);
  }, 120_000);

  it('treats a junk text layer as no text layer, and reads the pixels instead', async () => {
    // The case that makes "does the page have text" the wrong question: a scan
    // carrying ligature soup baked in by somebody else's OCR pass.
    const scan = await scannedPage('lltlt rn1n1 vvhh ffiffl xzxzxz qkqkqk lltlt rn1n1 vvhh ffiffl');
    const result = await readDocument(scan, {
      declaredContentType: PDF_CONTENT_TYPE,
      ladder: ladder(),
    });

    expect(result.report.pages?.[0]?.tier).toBe('ocr');
    expect(result.text.toLowerCase()).toContain('supplier');
    // The junk did not survive into the text the pipeline will extract from.
    expect(result.text).not.toContain('xzxzxz');
  }, 120_000);

  it('escalates to vision when OCR cannot read the page, and records the tier', async () => {
    const scan = await scannedPage();
    const vision = new ScriptedVision(() => ({
      text: 'TEXT: The supplier shall deliver the goods within thirty days of the order date.',
    }));
    const result = await readDocument(scan, {
      declaredContentType: PDF_CONTENT_TYPE,
      // OCR unavailable in this process forces the escalation deterministically,
      // without needing a fixture bad enough to defeat Tesseract.
      ladder: ladder({ ocr: false, vision }),
    });

    expect(vision.calls).toBe(1);
    expect(result.report.pages?.[0]?.tier).toBe('vision');
    expect(result.report.visionPagesUsed).toBe(1);
    expect(result.segments[0]?.locator).toMatchObject({ tier: 'vision' });
  }, 120_000);

  it('labels a page honestly when vision is needed and unavailable', async () => {
    const scan = await scannedPage();
    const result = await readDocument(scan, {
      declaredContentType: PDF_CONTENT_TYPE,
      ladder: ladder({ ocr: false, vision: null }),
    });

    // Not "read with no facts". A specific state, with a reason, and a source
    // that can be read again once the capability exists.
    expect(result.report.outcome).toBe('needs_vision');
    expect(result.report.reasonCode).toBe('vision_unavailable');
    expect(result.report.pages).toEqual([
      { page: 1, tier: null, reason: 'needs_vision_unavailable' },
    ]);
    expect(result.text).toBe('');
  }, 120_000);

  it('stops escalating at the per-document cap and marks the rest honestly', async () => {
    const scan = await scannedPage();
    const vision = new ScriptedVision(() => ({ text: 'TEXT: something' }));
    const result = await readDocument(scan, {
      declaredContentType: PDF_CONTENT_TYPE,
      ladder: ladder({ ocr: false, vision, caps: { visionPagesPerDocument: 0 } }),
    });

    expect(vision.calls).toBe(0);
    expect(result.report.outcome).toBe('needs_vision');
    expect(result.report.reasonCode).toBe('vision_cap_reached');
  }, 120_000);

  it('does not retry vision for every page once it has failed once', async () => {
    const scan = await scannedPage();
    const vision = new ScriptedVision(() => {
      throw new VisionUnavailableError('image_rejected', 'the projector is not loaded');
    });
    const result = await readDocument(scan, {
      declaredContentType: PDF_CONTENT_TYPE,
      ladder: ladder({ ocr: false, vision }),
    });

    expect(vision.calls).toBe(1);
    expect(result.report.outcome).toBe('needs_vision');
  }, 120_000);
});
