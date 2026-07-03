import { describe, expect, it } from 'vitest';
import { scanAnswer } from '@cogeto/shared';
import type { ChatFactDto } from '@cogeto/shared';
import { toStoredAnswer } from './answer-prompt';

/**
 * citation_never_leaks (owner test F6): the renderer/post-processor accept only
 * the canonical `{{cite:<uuid>}}` grammar; a raw `[F2, F4]`, malformed braces,
 * or a cite to an unsupplied id are stripped and counted, never rendered.
 */

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

const facts: ChatFactDto[] = [
  {
    marker: 'F1',
    memoryId: ID1,
    claim: 'Ana Kovač leads the Atlas CRM Migration',
    status: 'active',
    sensitive: false,
    subjectEntity: null,
    sourceType: 'user_note',
    sourceId: 'note-1',
    validFrom: null,
    validUntil: null,
    signals: ['entity'],
  },
  {
    marker: 'F2',
    memoryId: ID2,
    claim: 'Ana requested a risk register',
    status: 'active',
    sensitive: false,
    subjectEntity: null,
    sourceType: 'user_note',
    sourceId: 'note-2',
    validFrom: null,
    validUntil: null,
    signals: ['fts'],
  },
];

const noBraces = (text: string) => expect(text).not.toMatch(/[{}[\]]/);

describe('citation_never_leaks (F6)', () => {
  it('maps valid [F#] markers to canonical cites and strips everything else', () => {
    const raw =
      'Ana leads Atlas [F1]. See also the register [F2] and the batch [F2, F4]. ' +
      'Junk {{oops}} and {cite:bad} and a stray marker [F9] must vanish. ' +
      `A raw uuid cite {{cite:${UNKNOWN}}} is dropped too.`;
    const { text, violations } = toStoredAnswer(raw, facts);

    // Valid markers survived as canonical cites.
    expect(text).toContain(`{{cite:${ID1}}}`);
    expect(text).toContain(`{{cite:${ID2}}}`);
    // [F2, F4]: F2 maps, F4 is unknown → only the F2 cite remains, no bracket.
    // Nothing non-canonical survives anywhere.
    expect(text).not.toMatch(/\[F\d/);
    expect(text).not.toContain('oops');
    expect(text).not.toContain('cite:bad');
    expect(text).not.toContain(UNKNOWN);
    // Prose is intact.
    expect(text).toContain('Ana leads Atlas');
    expect(text).toContain('See also the register');
    expect(violations).toBeGreaterThan(0);

    // Re-scanning the stored text yields only text + valid cite segments.
    const scan = scanAnswer(text);
    const citeIds = scan.segments.filter((s) => s.kind === 'cite').map((s) => s.memoryId);
    expect(citeIds).toEqual([ID1, ID2, ID2]);
    for (const seg of scan.segments) {
      if (seg.kind === 'text') noBraces(seg.text);
    }
  });

  it('renderer strips [F2, F4], malformed braces, and unknown-id cites; only the valid chip renders', () => {
    const validIds = new Set([ID1]);
    const raw =
      `Confirmed {{cite:${ID1}}} inline. ` +
      `But [F2, F4] and {{broken} and {cite:${UNKNOWN}}} and {{cite:${UNKNOWN}}} are noise.`;
    const { segments, violations } = scanAnswer(raw, validIds);

    const cites = segments.filter((s) => s.kind === 'cite');
    expect(cites).toHaveLength(1);
    expect(cites[0]).toMatchObject({ kind: 'cite', memoryId: ID1 });
    expect(violations).toBeGreaterThan(0);
    for (const seg of segments) {
      if (seg.kind === 'text') noBraces(seg.text);
    }
    // The full rendered text carries no raw token characters.
    const rendered = segments.map((s) => (s.kind === 'text' ? s.text : '·')).join('');
    noBraces(rendered);
  });

  it('a clean answer with no citations passes through unchanged, zero violations', () => {
    const raw = 'I have nothing on record that answers this.';
    const { text, violations } = toStoredAnswer(raw, facts);
    expect(text).toBe(raw);
    expect(violations).toBe(0);
  });
});
