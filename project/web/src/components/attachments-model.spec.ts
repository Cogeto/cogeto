import { describe, expect, it } from 'vitest';
import { MAX_CHAT_ATTACHMENTS } from '@cogeto/shared';
import { dragHasFiles, pendingKey, stageAttachments } from './attachments-model';
import type { PendingFile } from './attachments-model';

/**
 * Staging files on the chat composer (issue #584).
 *
 * Every case here is a way of NOT losing what the user already had. Dropping
 * files is a gesture people repeat and mix: a folder among the files, one
 * enormous PDF, a sixth file onto five. Each of those has an obvious wrong
 * behaviour (clear the list, reject the batch, silently keep four) and this is
 * where the right one is pinned.
 */

const file = (name: string, size = 1024): File =>
  new File([new Uint8Array(size)], name, { type: '', lastModified: 1_700_000_000_000 });

/** A stand-in for the real validator: rejects anything not .pdf, or over 5 kB. */
const validate = (f: File): string | null => {
  if (!f.name.endsWith('.pdf')) return 'unsupported type';
  if (f.size > 5 * 1024) return 'too large';
  return null;
};

const staged = (...names: string[]): PendingFile[] =>
  names.map((name) => ({ file: file(name), transient: false, key: pendingKey(file(name)) }));

describe('stageAttachments', () => {
  it('stages valid files, defaulting to remembered rather than transient', () => {
    const { accepted, refused, capReached } = stageAttachments([], [file('a.pdf')], validate);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.transient).toBe(false);
    expect(refused).toEqual([]);
    expect(capReached).toBe(false);
  });

  it('judges each file on its own: one bad file never rejects the batch', () => {
    const { accepted, refused } = stageAttachments(
      [],
      [file('good.pdf'), file('nope.exe'), file('also-good.pdf')],
      validate,
    );
    expect(accepted.map((a) => a.file.name)).toEqual(['good.pdf', 'also-good.pdf']);
    expect(refused).toEqual(['nope.exe: unsupported type']);
  });

  it('names the file in every refusal, because with five staged a bare reason is a guess', () => {
    const { refused } = stageAttachments([], [file('huge.pdf', 9999), file('x.txt')], validate);
    expect(refused).toEqual(['huge.pdf: too large', 'x.txt: unsupported type']);
  });

  it('never clears what is already staged', () => {
    const existing = staged('kept.pdf');
    const { accepted } = stageAttachments(existing, [file('bad.exe')], validate);
    expect(accepted).toEqual([]); // the caller APPENDS, so `kept.pdf` survives
  });

  it('reports the cap instead of truncating in silence', () => {
    const existing = staged('1.pdf', '2.pdf', '3.pdf');
    const { accepted, capReached } = stageAttachments(
      existing,
      [file('4.pdf'), file('5.pdf'), file('6.pdf')],
      validate,
    );
    expect(accepted.map((a) => a.file.name)).toEqual(['4.pdf']);
    expect(capReached).toBe(true);
  });

  it('an invalid file does not consume a slot under the cap', () => {
    // Otherwise dropping junk would block the good file queued behind it.
    const existing = staged('1.pdf', '2.pdf', '3.pdf');
    const { accepted, refused, capReached } = stageAttachments(
      existing,
      [file('junk.exe'), file('wanted.pdf')],
      validate,
    );
    expect(accepted.map((a) => a.file.name)).toEqual(['wanted.pdf']);
    expect(refused).toHaveLength(1);
    expect(capReached).toBe(false);
  });

  it('defaults to the cap the ask endpoint enforces', () => {
    const many = Array.from({ length: MAX_CHAT_ATTACHMENTS + 2 }, (_, i) => file(`f${i}.pdf`));
    const { accepted, capReached } = stageAttachments([], many, validate);
    expect(accepted).toHaveLength(MAX_CHAT_ATTACHMENTS);
    expect(capReached).toBe(true);
  });

  it('an empty drop changes nothing', () => {
    expect(stageAttachments(staged('a.pdf'), [], validate)).toEqual({
      accepted: [],
      refused: [],
      capReached: false,
    });
  });

  it('keys distinguish same-named files of different sizes', () => {
    expect(pendingKey(file('a.pdf', 10))).not.toBe(pendingKey(file('a.pdf', 20)));
  });
});

describe('dragHasFiles', () => {
  const transfer = (types: string[]): DataTransfer => ({ types }) as unknown as DataTransfer;

  it('claims a drag carrying files', () => {
    expect(dragHasFiles(transfer(['Files']))).toBe(true);
    expect(dragHasFiles(transfer(['text/plain', 'Files']))).toBe(true);
  });

  it('leaves a TEXT drag alone, so dropping selected text still types it', () => {
    expect(dragHasFiles(transfer(['text/plain']))).toBe(false);
    expect(dragHasFiles(transfer(['text/uri-list']))).toBe(false);
    expect(dragHasFiles(transfer([]))).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });
});
