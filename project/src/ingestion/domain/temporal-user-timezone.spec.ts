import { describe, expect, it } from 'vitest';
import { resolveExpression } from './temporal-resolver';

/**
 * conversational_dates_resolve (P6.6, decision 0051): "next Thursday" in chat
 * resolves against the USER's timezone via the deterministic resolver — never
 * model arithmetic. The same instant is a different calendar day in different
 * zones, so the resolved date must follow the caller's zone.
 */

// 2026-07-23T01:30:00Z: in Zagreb (UTC+2) it is already Thursday 23 July;
// in Los Angeles (UTC-7) it is still Wednesday 22 July.
const INSTANT = new Date('2026-07-23T01:30:00Z');

describe('conversational_dates_resolve', () => {
  it('resolves "next Thursday" against the user timezone, not the instance one', () => {
    // Zagreb: today IS Thursday; "next Thursday" is strictly after → 30 July.
    expect(resolveExpression('next Thursday', INSTANT, 'Europe/Zagreb')?.toISOString()).toBe(
      '2026-07-30T00:00:00.000Z',
    );
    // Los Angeles: today is Wednesday; "next Thursday" is tomorrow → 23 July.
    expect(resolveExpression('next Thursday', INSTANT, 'America/Los_Angeles')?.toISOString()).toBe(
      '2026-07-23T00:00:00.000Z',
    );
  });

  it('resolves "tomorrow" to the user-local next day', () => {
    expect(resolveExpression('tomorrow', INSTANT, 'Europe/Zagreb')?.toISOString()).toBe(
      '2026-07-24T00:00:00.000Z',
    );
    expect(resolveExpression('tomorrow', INSTANT, 'America/Los_Angeles')?.toISOString()).toBe(
      '2026-07-23T00:00:00.000Z',
    );
  });

  it('always lands on the named weekday in the user zone', () => {
    for (const zone of ['Europe/Zagreb', 'America/Los_Angeles', 'Pacific/Auckland']) {
      const resolved = resolveExpression('next Thursday', INSTANT, zone);
      expect(resolved?.getUTCDay()).toBe(4);
    }
  });
});
