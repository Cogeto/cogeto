/**
 * The findings vocabulary's display maps (V2.3 item 6.1). Enum values are
 * never translated raw (AGENTS.md): each value maps to an explicit key
 * suffix, resolved by the caller under its own namespace prefix so the
 * static key scan sees the literal prefix. An unknown value gets no suffix
 * and the caller falls back to the raw string.
 */
export const RESOLUTION_KEY_SUFFIX: Record<string, string | undefined> = {
  confirmed_a: 'confirmedA',
  confirmed_b: 'confirmedB',
  corrected: 'corrected',
  dismissed: 'dismissed',
  revision: 'revision',
};
