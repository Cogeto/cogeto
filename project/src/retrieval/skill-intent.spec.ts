import { describe, expect, it } from 'vitest';
import { detectResearchIntent, detectSkillBriefIntent } from './query-rewrite';

/**
 * The skill-brief triggers (Priority 7, decision 0059): anchored imperatives,
 * checked BEFORE the research patterns so the more specific intent wins.
 */
describe('detectSkillBriefIntent', () => {
  it('detects the prep/brief forms (en)', () => {
    expect(detectSkillBriefIntent('prep me on Marko')).toEqual({ subject: 'Marko', lang: 'en' });
    expect(detectSkillBriefIntent('Prepare me for Adriatic Foods')).toEqual({
      subject: 'Adriatic Foods',
      lang: 'en',
    });
    expect(detectSkillBriefIntent('brief me on the company Adriatic Foods')).toEqual({
      subject: 'Adriatic Foods',
      lang: 'en',
    });
    expect(detectSkillBriefIntent('prep me for my meeting with Ana before Thursday')).toEqual({
      subject: 'Ana',
      lang: 'en',
    });
  });

  it('detects research-with-occasion as a brief, plain research stays research', () => {
    expect(detectSkillBriefIntent('research Adriatic Foods before Thursday')).toEqual({
      subject: 'Adriatic Foods',
      lang: 'en',
    });
    // No occasion → not a brief; the ordinary research intent handles it.
    expect(detectSkillBriefIntent('research Adriatic Foods')).toBeNull();
    expect(detectResearchIntent('research Adriatic Foods')).toMatchObject({
      topic: 'Adriatic Foods',
    });
    // The overlap case matches BOTH — dispatch order (skill first) decides.
    expect(detectResearchIntent('research Adriatic Foods before Thursday')).not.toBeNull();
  });

  it('detects the hr forms', () => {
    expect(detectSkillBriefIntent('pripremi me za sastanak s Adriatic Foods')).toEqual({
      subject: 'Adriatic Foods',
      lang: 'hr',
    });
    expect(detectSkillBriefIntent('Pripremi me za Adriatic Foods')).toEqual({
      subject: 'Adriatic Foods',
      lang: 'hr',
    });
    expect(
      detectSkillBriefIntent('istraži tvrtku Adriatic Foods prije sastanka u četvrtak'),
    ).toEqual({ subject: 'Adriatic Foods', lang: 'hr' });
    expect(detectSkillBriefIntent('istraži Adriatic Foods')).toBeNull();
  });

  it('never fires on ordinary questions or bare triggers (not ambient)', () => {
    expect(detectSkillBriefIntent('who is Marko?')).toBeNull();
    expect(detectSkillBriefIntent('what should I prep for tomorrow?')).toBeNull();
    expect(detectSkillBriefIntent('prep me on')).toBeNull();
    expect(detectSkillBriefIntent('tell me about Adriatic Foods')).toBeNull();
  });
});
