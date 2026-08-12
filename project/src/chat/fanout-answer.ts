import type { AmbiguityDecisionDto, ChatFactDto, PreferredLanguage } from '@cogeto/shared';
import { serverT } from '../infrastructure/index';
import { foldEntityName } from '../ingestion/index';

/**
 * The fan-out and silent-corpus texts (V2.3 item 6.3, spec §7.5.2 and
 * §7.5.3): fully server-authored, deterministic, no model call. A fan-out
 * line carries the cluster's best fact verbatim with its REAL canonical
 * citation token, so the chip renders with its status tone exactly like
 * every other citation; a localized verdict word rides along when the fact's
 * status deviates from plain active. Deterministic strings cannot mirror the
 * question's language, so they follow the anchor (0052), like every
 * server-authored reply.
 */

/** The silent-corpus preamble before a general-knowledge answer (§7.5.2).
 * Inside a project lens (V2.5 item 8.3) it names the PROJECT instead of "your
 * sources", because claiming the whole corpus is silent when only a project
 * was searched would be a false statement. */
export function silentPreamble(lang: PreferredLanguage, projectName?: string | null): string {
  return projectName
    ? serverT(lang, 'chat', 'lens.silentPreamble', { project: projectName })
    : serverT(lang, 'chat', 'ambiguity.silentPreamble');
}

/**
 * The lens gap (V2.5 item 8.3): the conversation's project holds nothing
 * above the relevance floor. Cogeto never widens silently and never refuses
 * silently, so it says which project it looked in and the surface offers the
 * one-tap widen beside it. Deterministic and server-authored, in the anchor
 * language like every other zero-answer reply.
 */
export function nothingInProject(lang: PreferredLanguage, projectName: string): string {
  return serverT(lang, 'chat', 'lens.nothingInProject', { project: projectName });
}

/**
 * The fan-out answer (§7.5.3): intro, one line per shown cluster in score
 * order, the honest cap line when more subjects matched, and the
 * disambiguating question. Never a bare clarifying question: every line
 * already answers for its subject, so the user often needs no reply at all.
 */
export function buildFanoutAnswer(
  decision: AmbiguityDecisionDto,
  factsById: ReadonlyMap<string, ChatFactDto>,
  lang: PreferredLanguage,
): string {
  const lines: string[] = [serverT(lang, 'chat', 'ambiguity.fanoutIntro'), ''];
  for (const cluster of decision.clusters) {
    if (!cluster.shown) continue;
    const fact = factsById.get(cluster.topMemoryId);
    if (!fact) continue;
    lines.push(
      serverT(lang, 'chat', 'ambiguity.line', {
        subject: cluster.subject,
        fact: (fact.claim ?? '').trim(),
        cite: `{{cite:${fact.memoryId}}}`,
        verdict: verdictSuffix(fact, lang),
      }),
    );
  }
  const hidden = decision.clusters.filter((c) => c.shown === false && c.key !== '').length;
  if (decision.capped && hidden > 0) {
    lines.push('', serverT(lang, 'chat', 'ambiguity.more', { count: hidden }));
  }
  lines.push('', serverT(lang, 'chat', 'ambiguity.whichDidYouMean'));
  return lines.join('\n');
}

/**
 * The verdict where one exists (§7.5.3 "where the question implies one"):
 * the fact's own stored verification outcome is the only verdict the system
 * possesses without a model call, so it is rendered whenever it deviates
 * from plain active, a deliberate superset of "where implied". Localized as
 * an enum display word, never a travelling value.
 */
function verdictSuffix(fact: ChatFactDto, lang: PreferredLanguage): string {
  const word =
    fact.status === 'uncertain'
      ? serverT(lang, 'chat', 'ambiguity.verdict.uncertain')
      : fact.status === 'contradicted'
        ? serverT(lang, 'chat', 'ambiguity.verdict.contradicted')
        : fact.pastBelief
          ? serverT(lang, 'chat', 'ambiguity.verdict.past')
          : null;
  return word ? ` (${word})` : '';
}

/**
 * Deterministic follow-up resolution (issue B, behaviour 4): when the
 * previous assistant turn fanned out and this turn names one of the offered
 * subjects, that subject is the answer to "which did you mean?". Matching is
 * fold-based containment on token boundaries, so "the VX-9, please" and a
 * Croatian case ending both land; several matches mean the reply named
 * several subjects, which rule 1 treats as a comparison.
 */
export function matchOfferedSubjects(
  reply: string,
  prior: AmbiguityDecisionDto | null | undefined,
): string[] {
  if (!prior || prior.branch !== 'fan_out') return [];
  const folded = ` ${foldEntityName(reply)} `;
  const matched: string[] = [];
  for (const cluster of prior.clusters) {
    if (!cluster.shown || !cluster.subject) continue;
    const subject = foldEntityName(cluster.subject);
    if (subject && folded.includes(` ${subject} `)) matched.push(cluster.subject);
  }
  return matched;
}
