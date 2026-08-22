import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Attribution invariants for third-party corpus documents.
 *
 * Most of the vertical corpus is public-sector text that carries no
 * obligations: EU material reusable under Commission Decision 2011/833/EU,
 * US Government works outside copyright under 17 U.S.C. section 105, and
 * Croatian official texts outside copyright under ZAPSP article 18(3).
 *
 * Two documents are different. The RP2040 and RP2350 datasheets are the
 * copyrighted product documentation of a commercial company, licensed
 * CC BY-ND 4.0. That licence permits reproduction in whole or in part, which
 * is what an excerpt is, but it requires the attribution to travel WITH the
 * material, and it withholds the right to distribute adapted material at all.
 *
 * Two failures follow, and neither is visible by reading the corpus README:
 *
 * 1. An excerpt committed with no notice beside it is redistribution without
 *    the attribution the licence conditions it on.
 * 2. This repository declares `AGPL-3.0-only`. Absent a notice, a reader
 *    reasonably concludes the excerpt is AGPL too. It is not, and the project
 *    has no power to relicense someone else's datasheet.
 *
 * So: every case directory carrying content from an attribution-required
 * document has an ATTRIBUTION.md naming that document. The required set is
 * DERIVED from `documents.json`, never hardcoded here, so adding a case from
 * a new CC BY-ND document fails this until its notice exists.
 *
 * The harness reads `source.txt` and `expected.json` from a case directory and
 * ignores everything else (`ingestion/eval-harness.ts`), so the notice file is
 * inert: it is legal metadata, never model input, and moves no eval number.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const VERTICAL = path.join(ROOT, 'eval', 'vertical');
const CASES = path.join(VERTICAL, 'cases');
const NOTICE = 'ATTRIBUTION.md';

/** Licences that condition redistribution on the notice travelling along. */
const ATTRIBUTION_REQUIRED = /creative commons|CC BY/i;

const manifestSchema = z.object({
  documents: z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      publisher: z.string().min(1),
      licence: z.string().min(1),
      licence_url: z.string().url().optional(),
    })
    .passthrough()
    .array()
    .nonempty(),
});

const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(path.join(VERTICAL, 'documents.json'), 'utf8')),
);

const restricted = manifest.documents.filter((d) => ATTRIBUTION_REQUIRED.test(d.licence));

/** Every case directory, with the text a reader of that directory would see. */
function caseDirs(): { id: string; dir: string; carried: string }[] {
  const out: { id: string; dir: string; carried: string }[] = [];
  for (const lang of readdirSync(CASES, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const langDir = path.join(CASES, lang.name);
    for (const entry of readdirSync(langDir, { withFileTypes: true }).filter((e) =>
      e.isDirectory(),
    )) {
      const dir = path.join(langDir, entry.name);
      // What this case redistributes: the excerpt, or the quoted spans in a
      // pair. `notes.md` is our own prose and names documents it only cites,
      // so reading it here would demand notices for cases that carry nothing.
      const carried = ['source.txt', 'pair.json']
        .filter((f) => existsSync(path.join(dir, f)))
        .map((f) => readFileSync(path.join(dir, f), 'utf8'))
        .join('\n');
      out.push({ id: entry.name, dir, carried });
    }
  }
  return out;
}

describe('vertical corpus — third-party attribution', () => {
  it('has at least one attribution-required document, or this guard is dead', () => {
    expect(restricted.length).toBeGreaterThan(0);
    for (const doc of restricted) expect(doc.licence_url).toBeTruthy();
  });

  it('every case carrying restricted content has a notice naming its documents', () => {
    const dirs = caseDirs();
    expect(dirs.length).toBeGreaterThan(0);

    for (const { id, dir, carried } of dirs) {
      // A case carries a restricted document when the notes record it as the
      // side's origin. `notes.md` is the provenance record; the carried text
      // itself never names its source.
      const notesFile = path.join(dir, 'notes.md');
      const notes = existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : '';
      const origin = /\*\*(?:Source|Sides)\.\*\*[\s\S]*?(?:\n\n|$)/.exec(notes)?.[0] ?? '';
      const used = restricted.filter((d) => origin.includes(d.id));
      if (used.length === 0) continue;

      const noticePath = path.join(dir, NOTICE);
      expect(
        existsSync(noticePath),
        `${id} reproduces ${used.map((d) => d.id).join(', ')} but has no ${NOTICE}`,
      ).toBe(true);

      const notice = readFileSync(noticePath, 'utf8');
      for (const doc of used) {
        // The four things CC BY-ND 4.0 section 3(a)(1) asks for when supplied:
        // the creator, the title, the licence with its URI, and a link back.
        expect(notice, `${id}: notice omits the publisher`).toContain(doc.publisher);
        expect(notice, `${id}: notice omits the title of ${doc.id}`).toContain(doc.title);
        expect(notice, `${id}: notice omits the licence URI of ${doc.id}`).toContain(
          doc.licence_url!,
        );
      }
      // And the thing an AGPL repository specifically has to say.
      expect(notice, `${id}: notice does not disclaim the project licence`).toMatch(
        /AGPL-3\.0-only/,
      );
      expect(carried.length, `${id} carries no reproduced text`).toBeGreaterThan(0);
    }
  });

  it('no notice sits in a directory that reproduces nothing restricted', () => {
    for (const { id, dir } of caseDirs()) {
      if (!existsSync(path.join(dir, NOTICE))) continue;
      const notesFile = path.join(dir, 'notes.md');
      const notes = existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : '';
      const origin = /\*\*(?:Source|Sides)\.\*\*[\s\S]*?(?:\n\n|$)/.exec(notes)?.[0] ?? '';
      expect(
        restricted.some((d) => origin.includes(d.id)),
        `${id} has a ${NOTICE} but its notes record no restricted document`,
      ).toBe(true);
    }
  });
});
