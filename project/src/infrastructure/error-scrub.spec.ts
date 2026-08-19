import { describe, expect, it } from 'vitest';
import { describeError, describeErrorLine, scrubMessage } from './error-scrub';

/**
 * The scrubber is part of the "never log memory content" guarantee: a
 * `ModelGatewayError` can embed Zod validation fragments whose quoted
 * `received` value is raw model output. The properties pinned here are the
 * ones the privacy property rests on: any `received <value>` fragment is
 * replaced, whichever quote style or casing Zod used, and no message ever
 * reaches a log line or the dead-letter column longer than 400 characters.
 */
describe('error_scrub: model output never reaches a log line', () => {
  describe('scrubMessage', () => {
    it('scrubs_a_double_quoted_received_value: the raw value is gone, the marker stays', () => {
      expect(scrubMessage('Invalid enum value. Expected "a" | "b", received "maybe"')).toBe(
        'Invalid enum value. Expected "a" | "b", received [redacted]',
      );
    });

    it('scrubs_single_quoted_and_backtick_values, the other two quote styles Zod emits', () => {
      expect(scrubMessage("Invalid input: received 'raw model output'")).toBe(
        'Invalid input: received [redacted]',
      );
      expect(scrubMessage('Invalid input: received `raw model output`')).toBe(
        'Invalid input: received [redacted]',
      );
    });

    it('scrubs_bareword_values, where Zod quotes nothing at all', () => {
      expect(scrubMessage('Invalid enum value... received maybe')).toBe(
        'Invalid enum value... received [redacted]',
      );
    });

    it('scrubs_case_insensitively: the fragment is model output whatever the casing', () => {
      expect(scrubMessage('Invalid input: Received "x" and RECEIVED `y`')).toBe(
        'Invalid input: received [redacted] and received [redacted]',
      );
    });

    it('scrubs_every_nested_fragment_in_one_message, not just the first', () => {
      // Zod can nest: an inner parse failure is quoted inside the outer value.
      expect(scrubMessage('Invalid input: received "a received \'b\' c" and received `d`')).toBe(
        'Invalid input: received [redacted] and received [redacted]',
      );
    });

    it('leaves_messages_without_a_received_fragment_alone', () => {
      const message = 'Failed to reach the model gateway';
      expect(scrubMessage(message)).toBe(message);
    });

    it('caps_at_400_chars_and_keeps_the_prefix', () => {
      const long = `received '${'x'.repeat(1000)}' then ${'tail '.repeat(200)}`;
      const scrubbed = scrubMessage(long);
      expect(scrubbed).toHaveLength(400);
      expect(scrubbed.startsWith('received [redacted]')).toBe(true);
    });

    it('leaves_a_message_exactly_at_the_cap_untouched', () => {
      const exact = 'y'.repeat(400);
      expect(scrubMessage(exact)).toBe(exact);
    });

    it('handles_empty_input', () => {
      expect(scrubMessage('')).toBe('');
    });
  });

  describe('describeError', () => {
    it('returns_class_and_scrubbed_message_for_an_error', () => {
      const result = describeError(new TypeError('Invalid input: received "maybe"'));
      expect(result.type).toBe('TypeError');
      expect(result.message).toBe('Invalid input: received [redacted]');
    });

    it('falls_back_to_the_constructor_name_when_error_name_is_empty', () => {
      const error = new Error('boom');
      Object.defineProperty(error, 'name', { value: '' });
      expect(describeError(error).type).toBe('Error');
    });

    it('caps_a_long_error_message_at_400_chars, whatever the redaction did to its length', () => {
      // 300 chars either side of the fragment keeps the message well over the
      // cap after the redaction (which can lengthen or shorten the text), so
      // the slice is what enforces the cap and the redaction marker survives
      // inside the capped message.
      const message = `${'a'.repeat(300)} received 'z' ${'b'.repeat(300)}`;
      const { message: scrubbed } = describeError(new Error(message));
      expect(scrubbed).toHaveLength(400);
      expect(scrubbed.startsWith('a'.repeat(300))).toBe(true);
      expect(scrubbed).toContain('received [redacted]');
    });

    it('passes_plain_strings_through_as_unknown, still scrubbed', () => {
      expect(describeError('boom received "x"')).toEqual({
        type: 'Unknown',
        message: 'boom received [redacted]',
      });
    });

    it('passes_null_and_undefined_through_sanely', () => {
      expect(describeError(null)).toEqual({ type: 'Unknown', message: 'null' });
      expect(describeError(undefined)).toEqual({ type: 'Unknown', message: 'undefined' });
    });

    it('stringifies_unexpected_objects_without_leaking_their_message', () => {
      // A thrown object is not an Error: its shape must never reach a log.
      expect(describeError({ message: 'received "secret"' })).toEqual({
        type: 'Unknown',
        message: '[object Object]',
      });
    });
  });

  describe('describeErrorLine', () => {
    it('joins_class_and_scrubbed_message_with_a_colon', () => {
      expect(describeErrorLine(new TypeError('received "maybe"'))).toBe(
        'TypeError: received [redacted]',
      );
    });

    it('scrubs_unknown_inputs_in_the_same_line', () => {
      expect(describeErrorLine("oops received 'x'")).toBe('Unknown: oops received [redacted]');
    });
  });
});
