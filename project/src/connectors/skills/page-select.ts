import type { DiscoveredPageDto } from '@cogeto/shared';

/**
 * The skill engine's page selection (decision 0059 ruling 5): relevance first
 * (the SearXNG score, exactly like chat's auto-selection), with a preference
 * for primary sources — a page whose HOST carries the subject's name (the
 * subject's own site) outranks a same-scored third-party mention. Pure and
 * deterministic so the choice is unit-tested and inspectable.
 */
export function selectPagesForSubject(
  results: DiscoveredPageDto[],
  subject: string,
  k: number,
): string[] {
  const tokens = subject
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3);
  const primary = (r: DiscoveredPageDto): number => {
    if (tokens.length === 0) return 0;
    try {
      const host = new URL(r.url).hostname.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      return tokens.some((t) => host.includes(t.replace(/[^\p{L}\p{N}]+/gu, ''))) ? 1 : 0;
    } catch {
      return 0;
    }
  };
  return [...results]
    .map((r, i) => ({ r, i, primary: primary(r) }))
    .sort(
      (a, b) =>
        b.primary - a.primary || (b.r.score ?? -Infinity) - (a.r.score ?? -Infinity) || a.i - b.i,
    )
    .slice(0, Math.max(0, k))
    .map(({ r }) => r.url);
}
