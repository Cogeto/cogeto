import { describe, expect, it } from 'vitest';
import {
  DEFUNCT_SOURCE_TYPES,
  isRegisteredSourceType,
  SOURCE_TYPE_KEYS,
  SOURCE_TYPES,
  sourceTypeDescriptor,
  sourceTypePromptLabel,
} from './source-types';

/**
 * The registry's conformance suite (spec §15.3). The database enum is gone,
 * so THIS is what proves the vocabulary is complete and every per-type
 * property the old switches encoded is present and coherent — for every
 * registered type, not a sampled one.
 */
describe('source-type registry', () => {
  it('completeness: every registered type carries every required metadata field', () => {
    for (const key of SOURCE_TYPE_KEYS) {
      const meta = SOURCE_TYPES[key];
      expect(typeof meta.defunct, `${key}.defunct`).toBe('boolean');
      expect(['always', 'never', 'per_item', 'none'], `${key}.userAuthored`).toContain(
        meta.userAuthored,
      );
      expect(typeof meta.objectBacked, `${key}.objectBacked`).toBe('boolean');
      expect(typeof meta.extraction, `${key}.extraction`).toBe('boolean');
      expect(
        meta.factBudget === null || (Number.isInteger(meta.factBudget) && meta.factBudget > 0),
        `${key}.factBudget must be null or a positive integer`,
      ).toBe(true);
      expect(meta.promptLabel.trim().length, `${key}.promptLabel`).toBeGreaterThan(0);
      expect([null, 'notes', 'email', 'files'], `${key}.dashboardFamily`).toContain(
        meta.dashboardFamily,
      );
    }
  });

  it('vocabulary: exactly the eight values the retired enum held, byte-identical', () => {
    // The stored strings feed the signed receipt chain's canonical payload;
    // renaming or dropping one invalidates a historical receipt.
    expect([...SOURCE_TYPE_KEYS].sort()).toEqual(
      [
        'user_note',
        'chat',
        'email',
        'calendar_event',
        'file',
        'task_conclusion',
        'web',
        'chat_conversation',
      ].sort(),
    );
  });

  it('defunct list is derived and matches the two retired subsystems', () => {
    expect([...DEFUNCT_SOURCE_TYPES].sort()).toEqual(['calendar_event', 'task_conclusion']);
  });

  it('coherence: a type without extraction has no fact budget and no authorship; a defunct type never extracts', () => {
    for (const key of SOURCE_TYPE_KEYS) {
      const meta = SOURCE_TYPES[key];
      if (!meta.extraction) {
        expect(meta.factBudget, `${key}: no extraction, so no fact budget`).toBeNull();
        expect(meta.userAuthored, `${key}: no extraction, so authorship never arises`).toBe('none');
      } else {
        expect(meta.userAuthored, `${key}: extraction implies an authorship contract`).not.toBe(
          'none',
        );
      }
      if (meta.defunct) expect(meta.extraction, `${key}: defunct types never extract`).toBe(false);
    }
  });

  it('object-backing: file is the single object-backed type (its source row IS file_metadata)', () => {
    expect(SOURCE_TYPE_KEYS.filter((key) => SOURCE_TYPES[key].objectBacked)).toEqual(['file']);
  });

  it('per-type behaviour the old switches encoded, pinned for every type', () => {
    // Pipeline fact caps: web is reference material, everything else uncapped.
    expect(SOURCE_TYPES.web.factBudget).toBe(30);
    for (const key of SOURCE_TYPE_KEYS.filter((k) => k !== 'web')) {
      expect(SOURCE_TYPES[key].factBudget, `${key} keeps the deployment cap`).toBeNull();
    }
    // First-person rule: what each reader declares (email computes per message).
    expect(SOURCE_TYPES.user_note.userAuthored).toBe('always');
    expect(SOURCE_TYPES.chat.userAuthored).toBe('always');
    expect(SOURCE_TYPES.email.userAuthored).toBe('per_item');
    expect(SOURCE_TYPES.file.userAuthored).toBe('never');
    expect(SOURCE_TYPES.web.userAuthored).toBe('never');
    // Attention chart families: the retired SOURCE_FAMILY map, exactly.
    expect(
      Object.fromEntries(SOURCE_TYPE_KEYS.map((key) => [key, SOURCE_TYPES[key].dashboardFamily])),
    ).toEqual({
      user_note: 'notes',
      chat: 'notes',
      email: 'email',
      file: 'files',
      web: null,
      chat_conversation: null,
      calendar_event: null,
      task_conclusion: null,
    });
    // Prompt labels: the retired `'user_note' ? 'note' : replace('_', ' ')`.
    expect(
      Object.fromEntries(SOURCE_TYPE_KEYS.map((key) => [key, SOURCE_TYPES[key].promptLabel])),
    ).toEqual({
      user_note: 'note',
      chat: 'chat',
      email: 'email',
      file: 'file',
      web: 'web',
      chat_conversation: 'chat conversation',
      calendar_event: 'calendar event',
      task_conclusion: 'task conclusion',
    });
  });

  it('unknown and defunct values are handled, never thrown on', () => {
    expect(isRegisteredSourceType('not_a_registered_type')).toBe(false);
    expect(sourceTypeDescriptor('not_a_registered_type')).toBeNull();
    expect(sourceTypePromptLabel('not_a_registered_type')).toBe('not a registered type');
    // A defunct value is a KNOWN value (AGENTS.md): registered, resolvable,
    // labelled — it simply has no live producer.
    expect(isRegisteredSourceType('task_conclusion')).toBe(true);
    expect(sourceTypeDescriptor('task_conclusion')?.defunct).toBe(true);
    expect(sourceTypePromptLabel('task_conclusion')).toBe('task conclusion');
    // Prototype names are not registry members.
    expect(isRegisteredSourceType('toString')).toBe(false);
    expect(isRegisteredSourceType('__proto__')).toBe(false);
  });
});
