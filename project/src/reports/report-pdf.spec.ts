import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PDFParse } from 'pdf-parse';
import { canonicalize } from '../memory/index';
import { buildReportFixturePayload } from './report-fixture';
import { reportPayloadSchema, sha256Hex } from './report-format';
import type { ReportArtifact } from './report-format';
import { renderReportPdf } from './report-pdf';
import { parseTtf } from './pdf/ttf';
import { parseLogoSvg } from './pdf/svg-logo';

/**
 * The rendered document (V2.3 item 6.2, issue C): a real PDF from the real
 * fonts and the real brand file, read back with the same parser the reading
 * layer uses. What matters: the evidence spans survive verbatim (Croatian
 * diacritics included, via the embedded font's ToUnicode map), the document
 * carries its verification values, and two renders of the same payload are
 * byte-identical (stable ordering is part of the format's promise).
 */

const FONTS_DIR = join(__dirname, '..', '..', 'fonts');
const BRAND_DIR = join(__dirname, '..', '..', '..', 'assets', 'brand');

function artifact(): ReportArtifact {
  const payload = reportPayloadSchema.parse(buildReportFixturePayload());
  const payloadSha256 = sha256Hex(Buffer.from(canonicalize(payload), 'utf8'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    findings_report_version: '1.0',
    payload,
    integrity: {
      algorithm: 'ed25519',
      canonicalization: 'sorted-keys-compact-json',
      payload_sha256: payloadSha256,
      signature: edSign(null, Buffer.from(payloadSha256, 'utf8'), privateKey).toString('base64'),
      public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      public_key_endpoint: '/api/instance/public-key',
    },
  };
}

function render(input: ReportArtifact): Buffer {
  return renderReportPdf({
    artifact: input,
    fonts: {
      regular: parseTtf(readFileSync(join(FONTS_DIR, 'DejaVuSans.ttf'))),
      bold: parseTtf(readFileSync(join(FONTS_DIR, 'DejaVuSans-Bold.ttf'))),
    },
    logo: parseLogoSvg(readFileSync(join(BRAND_DIR, 'cogeto-final-logo-horizontal.svg'), 'utf8')),
  });
}

describe('report pdf', () => {
  it('report_pdf_renders: a well-formed, multi-page PDF with the evidence intact', async () => {
    const doc = artifact();
    const bytes = render(doc);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.subarray(-7).toString('latin1')).toContain('%%EOF');

    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      const result = await parser.getText();
      expect(result.pages.length).toBeGreaterThanOrEqual(4);
      const text = result.pages.map((page) => page.text).join('\n');
      // The document's own words.
      expect(text).toContain('Findings report');
      expect(text).toContain('Executive summary');
      expect(text).toContain('Coverage and limits');
      // A verbatim Croatian span survives the embedded font's ToUnicode map.
      expect(text).toContain('Minimalna debljina vara');
      expect(text).toContain('šava W-12 iznosi 3,2 mm');
      // The two conflicting claims are both present.
      expect(text).toContain('minimum throat thickness of 3.2 mm');
      expect(text).toContain('2.9 mm');
      // OCR provenance is stated on the finding (issue B7).
      expect(text).toContain('recovered by OCR');
      // The verification page carries the values a verifier needs (issue D1/D2);
      // long values wrap across lines, so compare whitespace-free.
      expect(text.replace(/\s+/g, '')).toContain(doc.integrity.payload_sha256);
      expect(text).toContain(doc.payload.report.id);
      // Coverage names the unreadable document and the honest truncation.
      expect(text).toContain('Scanned appendix (1987).pdf');
      // Footer page numbers exist.
      expect(text).toContain('Page 1 of');
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  });

  it('report_pdf_deterministic: two renders of the same payload are byte-identical', () => {
    const doc = artifact();
    expect(render(doc).equals(render(doc))).toBe(true);
  });

  it('report_pdf_localized: the Croatian rendering keeps the verbatim span and translates nothing quoted', async () => {
    const doc = artifact();
    doc.payload.report.locale = 'hr';
    const bytes = render(doc);
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      const result = await parser.getText();
      const text = result.pages.map((page) => page.text).join('\n');
      // Quoted evidence is untouched by report language (issue C4).
      expect(text).toContain('šava W-12 iznosi 3,2 mm');
      expect(text).toContain('Seam W-12: measured throat thickness 2.9 mm');
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  });
});
