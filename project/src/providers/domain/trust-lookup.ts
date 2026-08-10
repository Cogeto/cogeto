import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TrustScoreSummaryDto } from '@cogeto/shared';

/**
 * What the published trust scores say about ONE configuration id (V2.4 item
 * 7.1). Newest release first; no match is `evaluated: false`, which the
 * interface renders as a plain "not evaluated" rather than an empty space.
 *
 * The rule the whole lookup exists to keep: **accuracy is never borrowed from a
 * different configuration.** An admin about to move the answer tier onto an
 * unmeasured model must be able to see that is what they are doing, and a
 * number carried over from a configuration that was measured would hide exactly
 * that.
 *
 * Deliberately not shared with the findings report's `readTrustScoresFor`
 * (V2.3 item 6.2), which answers the same question into a different shape: that
 * one produces the signed report payload's per-language block, this one three
 * headline numbers for a settings row. Sharing them would mean one function
 * with two return types and a flag.
 */
export async function summariseTrustFor(
  trustScoresDir: string,
  configurationId: string,
): Promise<TrustScoreSummaryDto> {
  const notEvaluated: TrustScoreSummaryDto = {
    configurationId,
    evaluated: false,
    release: null,
    extractionPrecision: null,
    extractionRecall: null,
    verificationAgreement: null,
  };
  let index: { version: string; path: string }[];
  try {
    index = JSON.parse(await readFile(join(trustScoresDir, 'index.json'), 'utf8')) as {
      version: string;
      path: string;
    }[];
  } catch {
    return notEvaluated;
  }
  // The probed reasoning marker is appended at emission time, so a measurement
  // of this configuration with thinking on still matches it (V2.3 Part C).
  const accepted = new Set([configurationId, `${configurationId}--reasoning`]);
  for (const entry of index) {
    let document: {
      configurations?: {
        id?: string;
        metrics?: {
          aggregate?: {
            extraction_precision?: number;
            extraction_recall?: number;
            verification_agreement?: number;
          };
        };
      }[];
    };
    try {
      document = JSON.parse(await readFile(join(trustScoresDir, entry.path), 'utf8')) as never;
    } catch {
      continue;
    }
    const matched = (document.configurations ?? []).find(
      (candidate) => candidate.id !== undefined && accepted.has(candidate.id),
    );
    if (!matched) continue;
    const aggregate = matched.metrics?.aggregate;
    return {
      configurationId,
      evaluated: true,
      release: entry.version,
      extractionPrecision: aggregate?.extraction_precision ?? null,
      extractionRecall: aggregate?.extraction_recall ?? null,
      verificationAgreement: aggregate?.verification_agreement ?? null,
    };
  }
  return notEvaluated;
}
