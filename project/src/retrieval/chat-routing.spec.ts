import { describe, expect, it } from 'vitest';
import { detectEntityProfile } from './entity-profile';
import {
  detectCreateTaskIntent,
  detectEmailReplyIntent,
  detectResearchIntent,
  detectSmallTalk,
  OPEN_LOOPS_HINT_RE,
  resolveQuestionClass,
  TEMPORAL_HINT_RE,
} from './query-rewrite';

/**
 * routing_matrix (decision 0046): every intent the conversational router
 * serves classifies correctly through its deterministic layer — including the
 * tricky adjacents ("what is open with Ana" vs "who is Ana" vs "research
 * Ana's company"). The model-classified classes (knowledge/smalltalk beyond
 * the lexicon) are covered by resolveQuestionClass with its veto guard; the
 * end-to-end routes are exercised in chat-conversation.integration.spec.ts.
 */
describe('routing_matrix (decision 0046)', () => {
  const noIntent = { temporal: null, openLoops: null, emailReply: null };

  it('the tricky adjacents: open-loops vs entity-profile vs research on the same entity', () => {
    // "what is open with Ana" → the open-loops hint fires (tasks mode).
    expect(OPEN_LOOPS_HINT_RE.test('what is open with Ana')).toBe(true);
    expect(detectResearchIntent('what is open with Ana')).toBeNull();
    expect(detectEntityProfile('what is open with Ana', ['Ana'])).toBeNull();

    // "who is Ana" → entity profile, not open loops, never research.
    expect(detectEntityProfile('who is Ana', ['Ana'])).toBe('Ana');
    expect(OPEN_LOOPS_HINT_RE.test('who is Ana')).toBe(false);
    expect(detectResearchIntent('who is Ana')).toBeNull();

    // "research Ana's company" → the explicit research imperative.
    expect(detectResearchIntent("research Ana's company")).toEqual({
      topic: "Ana's company",
      lang: 'en',
    });
    expect(detectEntityProfile("research Ana's company", ['Ana'])).toBeNull();
  });

  it('action intents: create-task beats reply-draft wording; questions veto both', () => {
    expect(detectCreateTaskIntent('remind me to reply to Ana')).toEqual({
      instruction: 'reply to Ana',
      lang: 'en',
    });
    expect(detectEmailReplyIntent("draft a reply to Ana's last email")).toEqual({
      target: 'Ana',
    });
    // Questions about tasks are retrieval, not creation.
    expect(detectCreateTaskIntent('did I make a task for Marko?')).toBeNull();
    // An ordinary question is never a reply request.
    expect(detectEmailReplyIntent('what did Ana answer about the invoice?')).toBeNull();
  });

  it('temporal and open-loops hints stay lexicon-guarded', () => {
    expect(TEMPORAL_HINT_RE.test('what did we previously decide about the platform?')).toBe(true);
    expect(TEMPORAL_HINT_RE.test('when is the workshop?')).toBe(false);
    expect(OPEN_LOOPS_HINT_RE.test('što je još otvoreno oko Adriatic Foodsa?')).toBe(true);
  });

  it('smalltalk_lexicon: pure pleasantries match whole-turn only, en and hr', () => {
    expect(detectSmallTalk('thanks!')).toEqual({ kind: 'thanks', lang: 'en' });
    expect(detectSmallTalk('Thank you so much')).toEqual({ kind: 'thanks', lang: 'en' });
    expect(detectSmallTalk('Hvala ti!')).toEqual({ kind: 'thanks', lang: 'hr' });
    expect(detectSmallTalk('hi')).toEqual({ kind: 'greeting', lang: 'en' });
    expect(detectSmallTalk('Dobro jutro')).toEqual({ kind: 'greeting', lang: 'hr' });
    expect(detectSmallTalk('ok, great')).toBeNull(); // compound — not the lexicon's job
    expect(detectSmallTalk('sounds good')).toEqual({ kind: 'ack', lang: 'en' });
    expect(detectSmallTalk('u redu')).toEqual({ kind: 'ack', lang: 'hr' });
    // A pleasantry followed by a real question never routes to small talk.
    expect(detectSmallTalk('thanks — and who is Ana?')).toBeNull();
    expect(detectSmallTalk('hvala, a što je otvoreno?')).toBeNull();
  });

  it('question class: the veto guard downgrades contradicted claims to personal', () => {
    // Classification failure / absent claim → the memory-question path.
    expect(resolveQuestionClass('who is Ana', null, noIntent)).toBe('personal');
    // A smalltalk claim on a turn naming an entity is a real question.
    expect(resolveQuestionClass('who is Ana Kovač?', 'smalltalk', noIntent)).toBe('personal');
    // A knowledge/smalltalk claim never overrides a resolved intent.
    expect(
      resolveQuestionClass('what changed since June?', 'knowledge', {
        ...noIntent,
        temporal: { kind: 'change_since', since: new Date() },
      }),
    ).toBe('personal');
    expect(
      resolveQuestionClass("what's still open?", 'smalltalk', {
        ...noIntent,
        openLoops: { entity: null },
      }),
    ).toBe('personal');
    // Honored claims pass through.
    expect(resolveQuestionClass('what does GDPR Article 17 require?', 'knowledge', noIntent)).toBe(
      'knowledge',
    );
    expect(resolveQuestionClass('what can you do?', 'smalltalk', noIntent)).toBe('smalltalk');
  });
});
