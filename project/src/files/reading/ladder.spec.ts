import { describe, expect, it } from 'vitest';
import { decideNextStep, PICTURE_INK_FRACTION } from './ladder';
import type { LadderLimits } from './ladder';
import { isUsable, plausibleWord, scoreText } from './page-quality';
import { MIN_MEAN_CONFIDENCE, scoreOcrResult } from './ocr';

/**
 * The routing is arithmetic, so it is testable without a binary, a model, or a
 * fixture — which is the property that makes it trustworthy: every page's path
 * through the ladder is reproducible and explainable.
 */

const A4 = { width: 8.27, height: 11.69 };
const prose = (repeat: number) =>
  'The supplier shall deliver the goods within thirty days of the order date. '.repeat(repeat);

const limits = (overrides: Partial<LadderLimits> = {}): LadderLimits => ({
  visionPagesLeft: 5,
  visionAvailable: true,
  ocrAvailable: true,
  ...overrides,
});

describe('what counts as a usable text layer', () => {
  it('takes an ordinary page of prose', () => {
    const quality = scoreText(prose(40), A4);
    expect(isUsable(quality)).toBe(true);
    expect(quality.notes).toContain('reads as ordinary text');
  });

  it('rejects a scan’s token text layer, which is the whole point', () => {
    // What a scanned PDF actually carries: a page number and a stray ligature.
    const quality = scoreText('3\nﬁ', A4);
    expect(isUsable(quality)).toBe(false);
    expect(quality.notes.join(' ')).toMatch(/page furniture/);
  });

  it('KEEPS a short but clean page rather than re-reading it from pixels', () => {
    // A title page. Perfectly good text, and sending it to OCR would spend work
    // to make already-correct text slightly worse. This is the case that broke
    // the pipeline parity test when the floor was set by length alone.
    const quality = scoreText('Ana will send the Atlas proposal to Marko on Friday.', A4);
    expect(isUsable(quality)).toBe(true);
  });

  it('rejects character soup even when there is plenty of it', () => {
    const soup = 'lltlt rn1n1 vvhh ffiffl xzxzxz qkqkqk '.repeat(60);
    const quality = scoreText(soup, A4);
    expect(isUsable(quality)).toBe(false);
    expect(quality.notes.join(' ')).toMatch(/look like words/);
  });

  it('rejects a layer full of replacement characters', () => {
    const broken = `${prose(40)}${'�'.repeat(400)}`;
    const quality = scoreText(broken, A4);
    expect(isUsable(quality)).toBe(false);
    expect(quality.notes.join(' ')).toMatch(/replacement or control/);
  });

  it('keeps Croatian, whose consonant clusters an English-tuned rule would reject', () => {
    const croatian =
      'Dobavljač se obvezuje isporučiti robu u roku od trideset dana od datuma narudžbe. '.repeat(
        40,
      );
    expect(isUsable(scoreText(croatian, A4))).toBe(true);
    for (const word of ['vrt', 'krst', 'črv', 'prst']) {
      expect(plausibleWord(word), word).toBe(true);
    }
  });

  it('keeps German, whose long compounds a length rule would reject', () => {
    const german =
      'Der Lieferant verpflichtet sich, die Ware innerhalb von dreißig Tagen nach Bestelldatum zu liefern. '.repeat(
        40,
      );
    expect(isUsable(scoreText(german, A4))).toBe(true);
    expect(plausibleWord('Lieferantenvereinbarung')).toBe(true);
  });
});

describe('the ladder routes cheapest-first', () => {
  it('takes a usable text layer and spends nothing', () => {
    const decision = decideNextStep({ text: scoreText(prose(40), A4) }, limits());
    expect(decision.step).toBe('take_text');
  });

  it('runs OCR when the text layer is unusable', () => {
    const decision = decideNextStep({ text: scoreText('3', A4) }, limits());
    expect(decision.step).toBe('run_ocr');
  });

  it('takes OCR output when it reads well, without escalating', () => {
    const decision = decideNextStep(
      { text: scoreText('3', A4), ocr: scoreText(prose(40), A4), ink: 0.3 },
      limits(),
    );
    expect(decision.step).toBe('take_text');
  });

  it('escalates to vision when OCR output is soup and there is ink on the page', () => {
    const decision = decideNextStep(
      { text: scoreText('3', A4), ocr: scoreText('vvhh rn1n1 lltlt', A4), ink: 0.25 },
      limits(),
    );
    expect(decision.step).toBe('run_vision');
  });

  it('escalates a picture page that has no text at all', () => {
    const decision = decideNextStep(
      { text: scoreText('', A4), ocr: scoreText('', A4), ink: 0.12 },
      limits(),
    );
    expect(decision.step).toBe('run_vision');
  });

  it('does NOT spend a vision call on a blank page', () => {
    // Scanner noise on an empty sheet: below the picture threshold.
    const decision = decideNextStep(
      { text: scoreText('', A4), ocr: scoreText('', A4), ink: PICTURE_INK_FRACTION / 4 },
      limits(),
    );
    expect(decision).toEqual({ step: 'give_up', reason: 'blank' });
  });

  it('says vision is unavailable rather than pretending the page was read', () => {
    const decision = decideNextStep(
      { text: scoreText('', A4), ocr: scoreText('', A4), ink: 0.3 },
      limits({ visionAvailable: false }),
    );
    expect(decision).toEqual({ step: 'give_up', reason: 'needs_vision_unavailable' });
  });

  it('stops escalating when the document has spent its cap, and says so', () => {
    const decision = decideNextStep(
      { text: scoreText('', A4), ocr: scoreText('', A4), ink: 0.3 },
      limits({ visionPagesLeft: 0 }),
    );
    expect(decision).toEqual({ step: 'give_up', reason: 'needs_vision_cap_reached' });
  });

  it('goes straight to escalation when OCR is not available in this process', () => {
    const decision = decideNextStep(
      { text: scoreText('', A4), ink: 0.3 },
      limits({ ocrAvailable: false }),
    );
    expect(decision.step).toBe('run_vision');
  });

  it('escalates word-SHAPED garbage that OCR was unsure about', () => {
    // The case a dictionary-free quality gate cannot catch on its own. A poor
    // scan reads as "CONIULTING AGREEMENT. KEY OBLIGATIOMS ... Ginsillani, Ara
    // Kavac": those tokens have vowels, ordinary length and no impossible
    // consonant runs, so they pass as words. Tesseract knew it was guessing
    // (mean confidence 55.7 against 91.9 for the same page rendered cleanly),
    // and that is the signal the ladder consults.
    const garbage =
      'CONIULTING AGREEMENT. KEY OBLIGATIOMS The Ginsillani, Ara Kavac wil Calr CAM mignuioo';
    expect(isUsable(scoreText(garbage, A4))).toBe(true); // text alone says fine
    expect(MIN_MEAN_CONFIDENCE).toBeGreaterThan(55.7); // the engine says otherwise
    expect(MIN_MEAN_CONFIDENCE).toBeLessThan(91.9); // and clean output still passes
  });

  it('judges OCR output the SAME way for an image as for a page', () => {
    // The two readers judged this separately at first, the confidence gate was
    // added to one of them, and a photographed diagram Tesseract read at 47.8
    // confidence (`e n ai`, `oi MEE`) counted as a good read in the other.
    const garbled = {
      text: 'Adriatic Foods; Rijeka warahouse network',
      meanConfidence: 47.8,
      languages: ['eng'],
    };
    expect(isUsable(scoreOcrResult(garbled, (t) => scoreText(t)))).toBe(false);

    const clean = { text: prose(6), meanConfidence: 90.6, languages: ['eng'] };
    expect(isUsable(scoreOcrResult(clean, (t) => scoreText(t)))).toBe(true);

    // No confidence reported at all: the text has to stand on its own.
    const unscored = { text: prose(6), meanConfidence: null, languages: ['eng'] };
    expect(isUsable(scoreOcrResult(unscored, (t) => scoreText(t)))).toBe(true);
  });

  it('reads a standalone image, which has no ink measurement to consult', () => {
    // The whole file IS the picture; there is no page to measure coverage on.
    const decision = decideNextStep({ text: scoreText(''), ocr: scoreText('') }, limits());
    expect(decision.step).toBe('run_vision');
  });
});
