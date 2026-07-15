import { describe, expect, it } from 'vitest';
import { detectEmailReplyIntent } from './query-rewrite';

describe('detectEmailReplyIntent (Session O4 — chat reply intent)', () => {
  it('detects a reply request and extracts the named target', () => {
    expect(detectEmailReplyIntent("draft a reply to Ana's last email")?.target).toBe('Ana');
    expect(detectEmailReplyIntent('reply to Marko')?.target).toBe('Marko');
    expect(detectEmailReplyIntent('write a response to that Adriatic Foods message')?.target).toBe(
      'Adriatic Foods',
    );
    expect(detectEmailReplyIntent('help me answer Ana')?.target).toBe('Ana');
  });

  it('resolves demonstratives / "the last one" to a null target (most recent wins)', () => {
    expect(detectEmailReplyIntent('reply to that')?.target).toBeNull();
    expect(detectEmailReplyIntent('draft a reply to the last email')).not.toBeNull();
    expect(detectEmailReplyIntent('draft a reply to the last email')?.target).toBeNull();
  });

  it('does not fire on everyday questions', () => {
    expect(detectEmailReplyIntent('what did Ana say about the proposal?')).toBeNull();
    expect(detectEmailReplyIntent("what's the answer to the budget question?")).toBeNull();
    expect(detectEmailReplyIntent('when is the deadline?')).toBeNull();
  });

  it('detects Croatian reply phrasings', () => {
    expect(detectEmailReplyIntent('napiši odgovor Ani')).not.toBeNull();
    expect(detectEmailReplyIntent('odgovori na Aninu poruku')).not.toBeNull();
  });

  it('the joined "e-poruka"/"e-mail" strips whole — no phantom "e-" sender (issue #78)', () => {
    // The live gate's reply_hr_zadnja case, verbatim: "the last email" with no
    // named sender must resolve to a null target (most recent email wins).
    const hr = detectEmailReplyIntent('Napiši odgovor na zadnju e-poruku');
    expect(hr).not.toBeNull();
    expect(hr?.target).toBeNull();
    expect(detectEmailReplyIntent('odgovori na posljednju e-poruku')?.target).toBeNull();
    expect(detectEmailReplyIntent('draft a reply to the last e-mail')?.target).toBeNull();
    // A real named target still survives the cleaning.
    expect(detectEmailReplyIntent('napiši odgovor na Aninu e-poruku')?.target).toBe('Aninu');
  });
});
