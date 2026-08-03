import { describe, expect, it } from 'vitest';
import { makePdf } from '../../testing/index';
import { availableOcrLanguages, ocrAvailable, parseTsv, readImage } from './ocr';
import {
  measurePageInk,
  parsePgm,
  rasterizerAvailable,
  renderPagePng,
  RasterizeError,
} from './rasterize';

/**
 * The two local tiers, against the real binaries (V2.1 item 4.1).
 *
 * These need `pdftoppm` and `tesseract` on PATH, which the runtime image
 * installs and a developer machine may not, so each block skips itself when its
 * tool is missing rather than failing a suite for an environment reason. CI
 * runs them: the `test` job builds against the same package set the image does.
 */

const hasPoppler = await rasterizerAvailable();
const hasTesseract = await ocrAvailable();

describe.skipIf(!hasPoppler)('rendering a PDF page', () => {
  it('renders a page to a PNG without touching the disk', async () => {
    const pdf = makePdf('The supplier shall deliver within thirty days.');
    const rendered = await renderPagePng(pdf, 1, { dpi: 100 });

    expect(rendered.mediaType).toBe('image/png');
    expect([...rendered.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('measures ink, which is how a blank page is told from a picture', async () => {
    const textPage = await measurePageInk(makePdf('Hello there, this is a line of text.'), 1);
    const blankPage = await measurePageInk(makePdf(' '), 1);

    // A line of text covers little of a page, but far more than nothing.
    expect(textPage.fraction).toBeGreaterThan(0);
    expect(blankPage.fraction).toBeLessThan(textPage.fraction);
    // The page size falls out of the render, so the text scorer gets a density.
    expect(textPage.widthInches).toBeGreaterThan(7);
    expect(textPage.heightInches).toBeGreaterThan(10);
  });

  it('refuses a file that is not a PDF, with the reason', async () => {
    await expect(renderPagePng(Buffer.from('not a pdf at all'), 1)).rejects.toBeInstanceOf(
      RasterizeError,
    );
  });
});

describe.skipIf(!hasTesseract)('local OCR', () => {
  it('reads text off a rendered page', async () => {
    const sentence = 'The supplier shall deliver the goods within thirty days.';
    const rendered = await renderPagePng(makePdf(sentence), 1, { dpi: 200 });
    const result = await readImage(rendered.bytes);

    // Not an exact match: OCR is OCR. The assertion is that the words are there.
    expect(result.text.toLowerCase()).toContain('supplier');
    expect(result.text.toLowerCase()).toContain('thirty days');
    expect(result.meanConfidence).toBeGreaterThan(50);
  });

  it('reports which language packs it actually has', async () => {
    const languages = await availableOcrLanguages();
    expect(languages).toContain('eng');
    // hrv and deu ship in the runtime image; a developer machine may lack them,
    // and the reader degrades to what is installed rather than failing.
    expect(languages.every((language) => ['eng', 'hrv', 'deu'].includes(language))).toBe(true);
  });
});

describe('parsing tool output needs no tools', () => {
  it('turns TSV into text, keeping line and paragraph structure', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t96\tThe',
      '5\t1\t1\t1\t1\t2\t0\t0\t10\t10\t95\tsupplier',
      '5\t1\t1\t1\t2\t1\t0\t0\t10\t10\t90\tshall',
      '5\t1\t2\t1\t1\t1\t0\t0\t10\t10\t80\tSigned',
      // A structural row: no word, confidence -1. Must not dilute the mean.
      '4\t1\t2\t1\t1\t0\t0\t0\t10\t10\t-1\t',
    ].join('\n');

    const parsed = parseTsv(tsv);
    expect(parsed.text).toBe('The supplier\nshall\n\nSigned');
    expect(parsed.meanConfidence).toBeCloseTo((96 + 95 + 90 + 80) / 4, 5);
  });

  it('reports no confidence when nothing was read', () => {
    expect(parseTsv('level\tpage\n')).toEqual({ text: '', meanConfidence: null });
  });

  it('parses a binary PGM header, comments and all', () => {
    const header = Buffer.from('P5\n# rendered by pdftoppm\n4 2\n255\n', 'latin1');
    const pixels = Buffer.from([0, 10, 250, 255, 255, 255, 128, 64]);
    const parsed = parsePgm(Buffer.concat([header, pixels]));

    expect(parsed.width).toBe(4);
    expect(parsed.height).toBe(2);
    expect([...parsed.pixels]).toEqual([...pixels]);
  });
});
