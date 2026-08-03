import { binaryAvailable, BinaryRunError, runBinary } from './run-binary';

/**
 * Tier two of the reading ladder (V2.1 item 4.1): local OCR.
 *
 * Tesseract, CPU-only, in the instance's own image, reading an image handed to
 * it on stdin and writing text to stdout. Nothing about the page leaves the
 * box, and nothing about it touches the disk.
 *
 * The languages are the product's languages. Tesseract is given all of them at
 * once (`-l eng+hrv+deu`) rather than being asked to detect one: a contract
 * with a German annex is one page in one file, script detection costs another
 * pass, and the combined model handles mixed pages better than a wrong guess
 * does. Any pack the image lacks is dropped from the list rather than failing
 * the read, so a trimmed image degrades to the languages it has.
 */

/** The language data the runtime image installs, in preference order. */
export const OCR_LANGUAGES = ['eng', 'hrv', 'deu'] as const;

export const OCR_TIMEOUT_MS = 120_000;

/** Tesseract's own confidence, 0..100, below which output is treated as noise. */
export const MIN_MEAN_CONFIDENCE = 55;

export class OcrError extends Error {
  constructor(
    message: string,
    readonly detail: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'OcrError';
  }
}

export interface OcrResult {
  text: string;
  /** Mean per-word confidence, 0..100, or null when the run reported none. */
  meanConfidence: number | null;
  /** The languages actually passed to the engine. */
  languages: string[];
}

let cachedLanguages: string[] | null = null;

/** Language packs actually present, cached: the answer cannot change at runtime. */
export async function availableOcrLanguages(): Promise<string[]> {
  if (cachedLanguages) return cachedLanguages;
  try {
    const result = await runBinary('tesseract', ['--list-langs'], {
      timeoutMs: 10_000,
      maxOutputBytes: 1 << 16,
    });
    // The list goes to stderr on some builds and stdout on others.
    const listed = `${result.stdout.toString('utf8')}\n${result.stderr}`
      .split('\n')
      .map((line) => line.trim());
    cachedLanguages = OCR_LANGUAGES.filter((language) => listed.includes(language));
  } catch {
    cachedLanguages = [];
  }
  return cachedLanguages;
}

/** Test seam: forget what was probed, so a spec can pin a different answer. */
export function resetOcrLanguageCache(): void {
  cachedLanguages = null;
}

export async function ocrAvailable(): Promise<boolean> {
  if (!(await binaryAvailable('tesseract', ['--version']))) return false;
  return (await availableOcrLanguages()).length > 0;
}

/**
 * Reads an image. Two passes are avoided deliberately: the TSV output carries
 * both the words and their confidences, so one run gives the text and the
 * quality signal the ladder needs to decide whether to escalate.
 */
export async function readImage(
  image: Buffer,
  options: { languages?: string[]; timeoutMs?: number } = {},
): Promise<OcrResult> {
  const languages = options.languages ?? (await availableOcrLanguages());
  if (languages.length === 0) {
    throw new OcrError('no OCR language data is installed', 'no languages');
  }

  let result;
  try {
    result = await runBinary(
      'tesseract',
      // `stdin stdout` reads and writes streams; `tsv` gives per-word rows.
      ['stdin', 'stdout', '-l', languages.join('+'), 'tsv'],
      { input: image, timeoutMs: options.timeoutMs ?? OCR_TIMEOUT_MS, maxOutputBytes: 32 << 20 },
    );
  } catch (error) {
    const detail = error instanceof BinaryRunError ? error.detail : String(error);
    throw new OcrError(`OCR could not run (${detail})`, detail, error);
  }
  if (result.code !== 0) {
    throw new OcrError(
      `tesseract exited ${result.code}${result.stderr ? `: ${result.stderr}` : ''}`,
      'nonzero exit',
    );
  }
  return { ...parseTsv(result.stdout.toString('utf8')), languages };
}

/**
 * Turns Tesseract's TSV into text plus a mean confidence.
 *
 * The columns are fixed: level, page, block, par, line, word, left, top, width,
 * height, conf, text. Only rows with a real word carry a usable confidence;
 * structural rows report -1 and are skipped, so a page of layout boxes cannot
 * dilute the average.
 */
export function parseTsv(tsv: string): { text: string; meanConfidence: number | null } {
  const lines = tsv.split('\n');
  const words: { text: string; confidence: number; line: number; block: number }[] = [];
  for (const row of lines.slice(1)) {
    const columns = row.split('\t');
    if (columns.length < 12) continue;
    const text = columns[11]!.trim();
    if (text === '') continue;
    const confidence = Number(columns[10]);
    words.push({
      text,
      confidence: Number.isFinite(confidence) ? confidence : -1,
      line: Number(columns[4]),
      block: Number(columns[2]),
    });
  }
  if (words.length === 0) return { text: '', meanConfidence: null };

  const parts: string[] = [];
  let previous = words[0]!;
  parts.push(previous.text);
  for (const word of words.slice(1)) {
    // A new block is a paragraph break; a new line inside a block is a newline.
    if (word.block !== previous.block) parts.push('\n\n');
    else if (word.line !== previous.line) parts.push('\n');
    else parts.push(' ');
    parts.push(word.text);
    previous = word;
  }

  const scored = words.filter((word) => word.confidence >= 0);
  const meanConfidence =
    scored.length === 0
      ? null
      : scored.reduce((total, word) => total + word.confidence, 0) / scored.length;
  return { text: parts.join('').trim(), meanConfidence };
}
