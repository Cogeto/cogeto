import { describe, expect, it } from 'vitest';
import { CHAT_ROUTING_ORDER } from './intents/intent-plumbing';
import { detectEntityProfile } from '../retrieval/index';
import {
  detectEmailReplyIntent,
  detectResearchIntent,
  detectSkillBriefIntent,
  detectSmallTalk,
  OPEN_LOOPS_HINT_RE,
  resolveQuestionClass,
  TEMPORAL_HINT_RE,
} from '../retrieval/index';

/**
 * routing_matrix: every intent the conversational router
 * serves classifies correctly through its deterministic layer — including the
 * tricky adjacents ("what is open with Ana" vs "who is Ana" vs "research
 * Ana's company"). The model-classified classes (knowledge/smalltalk beyond
 * the lexicon) are covered by resolveQuestionClass with its veto guard; the
 * end-to-end routes are exercised in chat-conversation.integration.spec.ts.
 */
describe('routing_matrix', () => {
  const noIntent = { temporal: null, openLoops: null, emailReply: null };

  it('the tricky adjacents: open-loops vs entity-profile vs research on the same entity', () => {
    // "what is open with Ana" → the open-loops hint fires (open_loops mode).
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

  it('action intents: the reply intent still fires; questions never do', () => {
    expect(detectEmailReplyIntent("draft a reply to Ana's last email")).toEqual({
      target: 'Ana',
    });
    // An ordinary question is never a reply request.
    expect(detectEmailReplyIntent('what did Ana answer about the invoice?')).toBeNull();
  });

  /**
   * routing_order: the create-task intent used to run BEFORE
   * the reply intent, so "remind me to reply to Ana" made a task rather than a
   * draft. With it gone, the surviving deterministic guards must still fire in
   * the order chat.service.ts applies them — small talk, then skill brief,
   * then research, then (after the router call) the reply intent — and no
   * earlier guard may now swallow a turn the later one owns. Order was
   * load-bearing before; this pins what it is now.
   */
  it('routing_order_as_data: the orchestrator sequence is exactly the documented seven steps', () => {
    // The order used to be implied by where each guard sat inside a 900-line
    // ask(); it is DATA now, and this assertion is what fails when someone
    // reorders it. The behavioural halves live below (detector precedence)
    // and in chat-research-intent.integration.spec (orchestrator precedence:
    // an input matching skill-brief AND research resolves to the brief).
    expect(CHAT_ROUTING_ORDER).toEqual([
      'small_talk_lexicon',
      'skill_brief',
      'research',
      'router_rewrite',
      'model_small_talk',
      'reply_draft',
      'memory_answer',
    ]);
  });

  it('routing_order: the surviving deterministic guards do not overlap', () => {
    // 1. Small talk is whole-turn only, so it never eats a real request.
    expect(detectSmallTalk('remind me to reply to Ana')).toBeNull();
    expect(detectSmallTalk('research Adriatic Foods before Thursday')).toBeNull();

    // 2. The skill brief runs BEFORE research and wins the occasion form.
    expect(detectSkillBriefIntent('research Adriatic Foods before Thursday')).toEqual({
      subject: 'Adriatic Foods',
      lang: 'en',
    });
    // …and a plain research imperative is NOT a brief, so it falls through.
    expect(detectSkillBriefIntent("research Ana's company")).toBeNull();
    expect(detectResearchIntent("research Ana's company")).toEqual({
      topic: "Ana's company",
      lang: 'en',
    });

    // 3. Neither guard claims a reply request; the reply intent (evaluated
    // after the router call) now sees it first and drafts.
    const reply = "draft a reply to Ana's last email";
    expect(detectSmallTalk(reply)).toBeNull();
    expect(detectSkillBriefIntent(reply)).toBeNull();
    expect(detectResearchIntent(reply)).toBeNull();
    expect(detectEmailReplyIntent(reply)).toEqual({ target: 'Ana' });

    // 4. A turn phrased as the retired create-task trigger is now an ordinary
    // turn: no guard claims it, so it reaches the memory-answer path.
    const retired = 'remind me to reply to Ana';
    expect(detectSkillBriefIntent(retired)).toBeNull();
    expect(detectResearchIntent(retired)).toBeNull();
    // It DOES read as a reply request now — the intended consequence of
    // dropping the create-task guard that used to shadow it.
    expect(detectEmailReplyIntent(retired)).toEqual({ target: 'Ana' });
  });

  it('temporal and open-loops hints stay lexicon-guarded', () => {
    expect(TEMPORAL_HINT_RE.test('what did we previously decide about the platform?')).toBe(true);
    expect(TEMPORAL_HINT_RE.test('when is the workshop?')).toBe(false);
    expect(OPEN_LOOPS_HINT_RE.test('što je još otvoreno oko Adriatic Foodsa?')).toBe(true);
    // To-do wording still reaches the open-loops path (query_rewrite/v0007)
    // it is how people ask, not the name of a feature.
    expect(OPEN_LOOPS_HINT_RE.test("what's on my to-do list?")).toBe(true);
    expect(OPEN_LOOPS_HINT_RE.test('koji su mi zadaci otvoreni?')).toBe(true);
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
