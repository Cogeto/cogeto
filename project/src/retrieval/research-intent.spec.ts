import { describe, expect, it } from 'vitest';
import { detectResearchIntent } from './query-rewrite';

/**
 * The research trigger is explicit invocation, never inference (decision
 * 0045): imperative research verbs anchored to the start of the turn, en+hr.
 * `not_ambient` is the contract's negative half — an ordinary question about a
 * company, a law, or the web must NEVER read as a research request.
 */
describe('detectResearchIntent', () => {
  it('detects explicit research invocations (en + hr) and extracts the topic', () => {
    expect(detectResearchIntent('research Adriatic Foods before Thursday')).toEqual({
      topic: 'Adriatic Foods before Thursday',
      lang: 'en',
    });
    expect(detectResearchIntent('Look up the latest on the EU AI Act timeline.')).toEqual({
      topic: 'the latest on the EU AI Act timeline',
      lang: 'en',
    });
    expect(detectResearchIntent('please search the web for GDPR consent rules')).toEqual({
      topic: 'GDPR consent rules',
      lang: 'en',
    });
    expect(detectResearchIntent('find out about Mojeek result quality')).toEqual({
      topic: 'Mojeek result quality',
      lang: 'en',
    });
    expect(detectResearchIntent('istraži rokove EU AI Acta')).toEqual({
      topic: 'rokove EU AI Acta',
      lang: 'hr',
    });
    expect(detectResearchIntent('potraži na webu cijene coworking prostora u Splitu')).toEqual({
      topic: 'cijene coworking prostora u Splitu',
      lang: 'hr',
    });
  });

  it('not_ambient: ordinary questions and retrieval phrasing never trigger research', () => {
    for (const question of [
      'what did I promise Marko about the March invoice?',
      'who is Adriatic Foods?',
      'when is the EU AI Act enforcement date?', // a question, not an instruction
      'did we research the EU AI Act already?', // mentions research, not imperative-first
      'search my notes for the Atlas proposal', // notes, not the web
      'I should research this at some point', // not anchored at the start
      'Što sam obećao Marku?',
      'tell me about our CRM migration',
    ]) {
      expect(detectResearchIntent(question), question).toBeNull();
    }
  });

  it('a bare trigger with no topic proposes nothing', () => {
    expect(detectResearchIntent('research')).toBeNull();
    expect(detectResearchIntent('look up')).toBeNull();
    expect(detectResearchIntent('istraži ?')).toBeNull();
  });
});
