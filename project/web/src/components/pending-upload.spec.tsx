// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { FileReadReportDto } from '@cogeto/shared';

/**
 * A file that read NOTHING must stay visible (V2.1 item 4.1, issue #398).
 *
 * This is the assertion that should have existed first, and its absence is
 * exactly why the hole survived review: every manual test used documents that
 * DID produce memories, so the drawer was never opened for a file that produced
 * none — the only case the reading layer's honesty rules are about.
 *
 * The queue's own state cannot answer the question. A scan that needs a vision
 * model runs a pipeline job that SUCCEEDS; it just has nothing to show for it.
 * Deciding by job state is what dropped the row and made the file look
 * processed. The decision belongs to the read report, and that rule is what is
 * pinned here.
 */

/** Mirrors the rule in UploadCard: which outcomes mean "nothing was read". */
const UNREAD_OUTCOMES = ['needs_vision', 'empty', 'read_failed', 'unsupported_format'];

const report = (outcome: FileReadReportDto['outcome']): FileReadReportDto => ({
  format: 'pdf',
  outcome,
  reasonCode: outcome === 'needs_vision' ? 'vision_unavailable' : 'no_readable_text',
  segments: 0,
  sheets: [],
  valuesUnavailable: 0,
  readAt: new Date().toISOString(),
});

const isUnread = (read: FileReadReportDto | null): boolean =>
  read !== null && UNREAD_OUTCOMES.includes(read.outcome);

describe('an upload that produced nothing stays on screen', () => {
  it('keeps a scan that needs a vision model, whose JOB succeeded', () => {
    expect(isUnread(report('needs_vision'))).toBe(true);
  });

  it('keeps a document with nothing readable in it', () => {
    expect(isUnread(report('empty'))).toBe(true);
  });

  it('keeps a file the reader could not read, and one it does not support', () => {
    expect(isUnread(report('read_failed'))).toBe(true);
    expect(isUnread(report('unsupported_format'))).toBe(true);
  });

  it('drops a file that WAS read: its memories in the list are the confirmation', () => {
    expect(isUnread(report('read'))).toBe(false);
    // Partly read is still read: the pages that came through produced facts,
    // and the drawer carries the truncation notice.
    expect(isUnread(report('truncated'))).toBe(false);
  });

  it('does not decide before the report has arrived', () => {
    // Dropping the row first and asking afterwards is precisely how the unread
    // case became invisible.
    expect(isUnread(null)).toBe(false);
  });
});
