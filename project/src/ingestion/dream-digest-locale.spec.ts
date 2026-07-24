import { describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import type { MemoryStore } from '../memory/index';
import { buildDigestLines } from './dream-digest';
import type { DreamActionRow } from './persistence/tables';

/**
 * initiated_content_in_preferred (P6.6, decision 0052): everything Cogeto
 * INITIATES speaks the user's preferred language. The digest lines are
 * deterministic string tables, so an hr user's digest comes back in Croatian
 * with the line ORDER unchanged (the attention feed's dismissal keys index
 * into it).
 */

const owner: Principal = {
  userId: 'user-digest-locale',
  name: 'Ana',
  email: null,
  orgId: 'org-d',
  orgName: 'Org',
  roles: [],
};

const MEM_A = '55555555-5555-4555-8555-555555555551';
const MEM_B = '55555555-5555-4555-8555-555555555552';

const storeWith = (rows: Array<{ id: string; subjectEntity: string }>): MemoryStore =>
  ({
    getManyForPrincipal: async () =>
      rows.map((r) => ({ id: r.id, subjectEntity: r.subjectEntity, entities: [], content: '' })),
  }) as unknown as MemoryStore;

const actionOf = (memoryId: string, pass: DreamActionRow['pass']): DreamActionRow =>
  ({ id: `${memoryId}:${pass}`, runId: 'run-1', memoryId, pass }) as unknown as DreamActionRow;

describe('initiated_content_in_preferred', () => {
  const store = storeWith([
    { id: MEM_A, subjectEntity: 'Adriatic Foods' },
    { id: MEM_B, subjectEntity: 'Marko' },
  ]);
  const actions = [actionOf(MEM_A, 'contradiction'), actionOf(MEM_B, 'dormant')];

  it('an hr user gets Croatian digest lines in the same order', async () => {
    const en = await buildDigestLines(store, owner, actions, 'en');
    const hr = await buildDigestLines(store, owner, actions, 'hr');
    expect(en.map((l) => l.text)).toEqual([
      'Found a conflict about Adriatic Foods — your call',
      'A commitment about Marko has gone quiet',
    ]);
    expect(hr.map((l) => l.text)).toEqual([
      'Pronađen je sukob oko Adriatic Foods — tvoja odluka',
      'Obveza oko Marko je utihnula',
    ]);
    // Same order, same hrefs — only the language differs.
    expect(hr.map((l) => l.href)).toEqual(en.map((l) => l.href));
  });

  it('defaults to English when no locale is given', async () => {
    const lines = await buildDigestLines(store, owner, [actionOf(MEM_A, 'dedup')]);
    expect(lines[0]!.text).toBe('Merged two notes about Adriatic Foods');
  });
});
