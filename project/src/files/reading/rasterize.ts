import { binaryAvailable, BinaryRunError, runBinary } from './run-binary';

/**
 * Rendering a PDF page to an image (V2.1 item 4.1), via `pdftoppm` from
 * poppler-utils, which ships in the runtime image.
 *
 * Two renders, for two different jobs, and the cheap one is used to decide
 * whether the expensive one is worth doing:
 *
 * - **A gray PGM at low DPI** to measure how much ink is on the page. PGM is
 *   raw bytes behind a five-token header, so measuring coverage is a loop over
 *   a buffer with no image library anywhere in the dependency tree. This is
 *   what tells a blank separator sheet from a schematic, and it costs
 *   milliseconds.
 * - **A PNG at reading DPI** for OCR and, if it comes to it, for the vision
 *   model.
 *
 * Rendering at a bounded DPI is also what bounds the image SIZE, which is why
 * nothing here resizes or re-encodes anything: the size ceiling is chosen
 * before the pixels exist rather than repaired afterwards.
 */

/** DPI for OCR and vision. 200 is the low end of what Tesseract reads reliably;
 * 300 is the usual recommendation and roughly doubles the pixel count. 200 is
 * the compromise: it reads ordinary print well and keeps a page image around a
 * megabyte, which matters when the next stop might be a model. */
export const READ_DPI = 200;

/** DPI for the ink measure. Coverage is a ratio, so it needs no detail at all;
 * 25 DPI renders an A4 page to about 200x290 pixels in a few milliseconds. */
export const INK_DPI = 25;

/** Hard ceiling on one render, so a pathological page cannot wedge a worker. */
export const RASTERIZE_TIMEOUT_MS = 60_000;

/** Refuse to hand anything larger than this to a model or an OCR pass. */
export const MAX_PAGE_IMAGE_BYTES = 12 * 1024 * 1024;

export class RasterizeError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RasterizeError';
  }
}

export interface RenderedPage {
  bytes: Buffer;
  mediaType: 'image/png';
}

/** True when poppler is present in this process's environment. */
export async function rasterizerAvailable(): Promise<boolean> {
  // `pdftoppm -v` prints its version and exits 0 on poppler builds; a missing
  // binary throws before that.
  return binaryAvailable('pdftoppm', ['-v']);
}

/**
 * Renders one page (1-based) to a PNG. `pdftoppm` writes to stdout with `-`,
 * so nothing touches the filesystem: a scanned contract never becomes a
 * temporary file somebody forgot to delete.
 */
export async function renderPagePng(
  pdf: Buffer,
  page: number,
  options: { dpi?: number; timeoutMs?: number } = {},
): Promise<RenderedPage> {
  const bytes = await pdftoppm(
    pdf,
    ['-png', '-r', String(options.dpi ?? READ_DPI), '-f', String(page), '-l', String(page), '-'],
    options.timeoutMs ?? RASTERIZE_TIMEOUT_MS,
  );
  if (bytes.length > MAX_PAGE_IMAGE_BYTES) {
    throw new RasterizeError(
      `page ${page} rendered to ${bytes.length} bytes, over the ${MAX_PAGE_IMAGE_BYTES}-byte cap`,
    );
  }
  return { bytes, mediaType: 'image/png' };
}

export interface PageInk {
  /** Share of the page that is not blank paper, 0..1. */
  fraction: number;
  /** Page size in inches, derived from the render: pixels ÷ DPI. */
  widthInches: number;
  heightInches: number;
}

/**
 * Measures how much of a page is covered in anything at all.
 *
 * Everything darker than {@link INK_THRESHOLD} counts as ink. Scanner noise and
 * paper texture sit close to white, so a genuinely blank scanned page measures
 * a fraction of a percent, while anything carrying information measures whole
 * percents. That gap is what the ladder's picture test relies on.
 */
export async function measurePageInk(
  pdf: Buffer,
  page: number,
  options: { dpi?: number; timeoutMs?: number } = {},
): Promise<PageInk> {
  const dpi = options.dpi ?? INK_DPI;
  const pgm = await pdftoppm(
    pdf,
    ['-gray', '-r', String(dpi), '-f', String(page), '-l', String(page), '-'],
    options.timeoutMs ?? RASTERIZE_TIMEOUT_MS,
  );
  const { width, height, pixels } = parsePgm(pgm);
  let inked = 0;
  for (const value of pixels) if (value < INK_THRESHOLD) inked += 1;
  return {
    fraction: pixels.length === 0 ? 0 : inked / pixels.length,
    widthInches: width / dpi,
    heightInches: height / dpi,
  };
}

/** 8-bit gray below this is ink. 250 keeps paper texture and JPEG ringing out. */
export const INK_THRESHOLD = 250;

/**
 * Parses a binary PGM (`P5`), which is a header of four whitespace-separated
 * tokens followed by one byte per pixel. Comment lines start with `#`.
 */
export function parsePgm(data: Buffer): { width: number; height: number; pixels: Buffer } {
  if (data.subarray(0, 2).toString('latin1') !== 'P5') {
    throw new RasterizeError('expected a binary PGM (P5) from pdftoppm');
  }
  const tokens: number[] = [];
  let at = 2;
  while (tokens.length < 3 && at < data.length) {
    const char = data[at]!;
    if (char === 0x23) {
      while (at < data.length && data[at] !== 0x0a) at += 1;
      continue;
    }
    if (char === 0x20 || char === 0x09 || char === 0x0a || char === 0x0d) {
      at += 1;
      continue;
    }
    let value = 0;
    while (at < data.length && data[at]! >= 0x30 && data[at]! <= 0x39) {
      value = value * 10 + (data[at]! - 0x30);
      at += 1;
    }
    tokens.push(value);
  }
  // Exactly one whitespace byte separates the header from the pixel data.
  at += 1;
  const [width = 0, height = 0] = tokens;
  return { width, height, pixels: data.subarray(at, at + width * height) };
}

async function pdftoppm(pdf: Buffer, args: string[], timeoutMs: number): Promise<Buffer> {
  let result;
  try {
    result = await runBinary('pdftoppm', args, {
      input: pdf,
      timeoutMs,
      maxOutputBytes: MAX_PAGE_IMAGE_BYTES,
    });
  } catch (error) {
    const detail = error instanceof BinaryRunError ? error.detail : String(error);
    throw new RasterizeError(`could not render the page (${detail})`, error);
  }
  if (result.code !== 0) {
    throw new RasterizeError(
      `pdftoppm exited ${result.code}${result.stderr ? `: ${result.stderr}` : ''}`,
    );
  }
  if (result.stdout.length === 0) throw new RasterizeError('pdftoppm produced no output');
  return result.stdout;
}
