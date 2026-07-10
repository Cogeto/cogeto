/**
 * Regenerates the fictional "Adriatic Foods consulting agreement" PDF used as
 * the Ana sandbox deletion-receipt demo object (decision 0022). Fictional — no
 * real person or company. Run: `node project/demo/assets/build-agreement.mjs`.
 *
 * Produces a real single-page PDF whose text `pdf-parse` extracts, so the seed
 * exercises the actual O1 document-extraction pipeline (not a stub). The text is
 * written to yield several derived memories (parties, scope, fee, term, notice).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LINES = [
  'CONSULTING AGREEMENT',
  '',
  'This Consulting Agreement is entered into between Ana Kovac (the',
  'Consultant), an independent consultant, and Adriatic Foods d.o.o. (the',
  'Client).',
  '',
  '1. Scope. The Consultant provides advisory services for the Atlas CRM',
  '   Migration project, including planning, data-migration oversight and',
  '   go-live support.',
  '',
  '2. Fee. The Client pays the Consultant EUR 12,000 per month, invoiced',
  '   monthly. Invoices are sent to billing@adriaticfoods.hr.',
  '',
  '3. Term. This Agreement runs from 1 May 2026 through 31 December 2026',
  '   and renews only by written agreement of both parties.',
  '',
  '4. Termination. Either party may terminate this Agreement on 30 days',
  '   written notice.',
  '',
  '5. Confidentiality. The Consultant keeps all Client information',
  '   confidential during and after the engagement.',
  '',
  '6. Governing law. This Agreement is governed by the laws of the',
  '   Republic of Croatia.',
  '',
  'Signed: Ana Kovac, Consultant.',
  'Signed: Marko, for Adriatic Foods d.o.o.',
];

/** Build a single-page PDF with multiple text lines (leading-based T*). */
function buildPdf(lines) {
  const esc = (s) => s.replace(/([\\()])/g, '\\$1');
  const shown = lines.map((l) => `(${esc(l)}) Tj T*`).join('\n');
  const stream = `BT /F1 11 Tf 14 TL 64 760 Td\n${shown}\nET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => (pdf += `${String(off).padStart(10, '0')} 00000 n \n`));
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const out = join(dirname(fileURLToPath(import.meta.url)), 'adriatic-foods-consulting-agreement.pdf');
writeFileSync(out, buildPdf(LINES));
console.log(`wrote ${out} (${LINES.length} lines)`);
