import { describe, expect, it } from 'vitest';
import { buildContextBlock, formatNow, formatUserContext } from './context-block';
import { EMPTY_USER_CONTEXT } from './user-context';
import type { UserContextRecord } from './user-context';

/**
 * The now-block builder (P6.6, decision 0051): the NOW line is always present
 * and timezone-correct; unset profile fields are ABSENT (no placeholders); the
 * LANGUAGE line follows the three rules of decision 0052.
 */

const record = (overrides: Partial<UserContextRecord>): UserContextRecord => ({
  ...EMPTY_USER_CONTEXT,
  ...overrides,
});

// A fixed instant: 2026-07-24T01:30:00Z. In Zagreb (UTC+2, summer) this is
// Friday 03:30; in Los Angeles (UTC-7) it is still Thursday 18:30.
const NOW = new Date('2026-07-24T01:30:00Z');

describe('formatNow', () => {
  it('renders date, weekday and time in the given timezone', () => {
    expect(formatNow(NOW, 'Europe/Zagreb')).toBe('Friday, 2026-07-24, 03:30 (Europe/Zagreb)');
    expect(formatNow(NOW, 'America/Los_Angeles')).toBe(
      'Thursday, 2026-07-23, 18:30 (America/Los_Angeles)',
    );
  });
});

describe('buildContextBlock', () => {
  it('empty_fields_absent: unset fields produce no mention at all', () => {
    const block = buildContextBlock(record({}), NOW, 'Europe/Zagreb');
    expect(block).toBe('NOW: Friday, 2026-07-24, 03:30 (Europe/Zagreb)');
    expect(block).not.toMatch(/unknown/i);
    expect(block).not.toMatch(/company/i);
    expect(block).not.toMatch(/USER CONTEXT/);

    const partial = formatUserContext(record({ company: 'MVT Solutions' }));
    expect(partial).toBe('The user works at MVT Solutions.');
    expect(partial).not.toMatch(/name|role|about/i);
  });

  it('phrases the full profile plainly', () => {
    const block = buildContextBlock(
      record({
        displayName: 'Ivan',
        roleTitle: 'CTO',
        company: 'MVT Solutions',
        aboutWork: 'fractional CTO work for industrial SMEs',
      }),
      NOW,
      'Europe/Zagreb',
    );
    expect(block).toContain(
      "USER CONTEXT (from the user's settings, not from memory — never cite): " +
        'The user is Ivan, CTO at MVT Solutions. ' +
        'About their work: fractional CTO work for industrial SMEs',
    );
  });

  it('includes the LANGUAGE line only when asked (the rewriter omits it)', () => {
    const ctx = record({ preferredLanguage: 'hr' });
    expect(buildContextBlock(ctx, NOW, 'Europe/Zagreb')).not.toContain('LANGUAGE:');
    expect(buildContextBlock(ctx, NOW, 'Europe/Zagreb', { language: true })).toContain('LANGUAGE:');
  });

  it('mirrors by default with the preferred language as tie-breaker', () => {
    const block = buildContextBlock(record({ preferredLanguage: 'hr' }), NOW, 'Europe/Zagreb', {
      language: true,
    });
    expect(block).toContain(
      "LANGUAGE: answer in the language of the user's message; " +
        'when it is mixed or ambiguous, use Croatian',
    );
  });

  it('strict mode always answers in the preferred language', () => {
    const block = buildContextBlock(
      record({ preferredLanguage: 'hr', languageStrict: true }),
      NOW,
      'Europe/Zagreb',
      { language: true },
    );
    expect(block).toContain(
      "LANGUAGE: always answer in Croatian, whatever language the user's message uses",
    );
  });
});
