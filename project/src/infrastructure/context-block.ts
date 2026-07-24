import type { PreferredLanguage } from '@cogeto/shared';
import type { UserContextRecord } from './user-context';

/**
 * The now-block (P6.6, decision 0051): the small labeled context block every
 * answer-tier and rewriter call receives. Pure assembly, no I/O.
 *
 * Shape rules, frozen in the decision record:
 *  - The NOW line is always present: date, weekday and time in the user's
 *    effective timezone.
 *  - USER CONTEXT appears only when at least one profile field is set; unset
 *    fields are ABSENT — no "company: unknown", no placeholders.
 *  - LANGUAGE (decision 0052) states the reply-language rule: mirroring by
 *    default with preferred_language as the tie-breaker, or always
 *    preferred_language in strict mode. Callers that produce structured JSON
 *    (the rewriter) omit it.
 */

export const LANGUAGE_NAMES: Record<PreferredLanguage, string> = {
  en: 'English',
  hr: 'Croatian',
};

export interface ContextBlockOptions {
  /** Include the LANGUAGE reply-rule line (answer-tier calls). */
  language?: boolean;
}

/** `Thursday, 2026-07-24, 14:32 (Europe/Zagreb)` — deterministic, tz-correct. */
export function formatNow(now: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return `${weekday}, ${date}, ${time} (${timeZone})`;
}

/** The plainly-phrased profile sentence(s); empty string when nothing is set. */
export function formatUserContext(context: UserContextRecord): string {
  const sentences: string[] = [];
  const name = context.displayName?.trim() || null;
  const role = context.roleTitle?.trim() || null;
  const company = context.company?.trim() || null;
  if (name && role && company) {
    sentences.push(`The user is ${name}, ${role} at ${company}.`);
  } else if (name && role) {
    sentences.push(`The user is ${name}, ${role}.`);
  } else if (name && company) {
    sentences.push(`The user is ${name}. They work at ${company}.`);
  } else if (name) {
    sentences.push(`The user is ${name}.`);
  } else if (role && company) {
    sentences.push(`The user is ${role} at ${company}.`);
  } else if (role) {
    sentences.push(`The user is ${role}.`);
  } else if (company) {
    sentences.push(`The user works at ${company}.`);
  }
  const about = context.aboutWork?.trim() || null;
  if (about) sentences.push(`About their work: ${about}`);
  return sentences.join(' ');
}

export function formatLanguageRule(context: UserContextRecord): string {
  const preferred = LANGUAGE_NAMES[context.preferredLanguage];
  return context.languageStrict
    ? `always answer in ${preferred}, whatever language the user's message uses`
    : `answer in the language of the user's message; when it is mixed or ambiguous, use ${preferred}`;
}

export function buildContextBlock(
  context: UserContextRecord,
  now: Date,
  timeZone: string,
  options: ContextBlockOptions = {},
): string {
  const lines = [`NOW: ${formatNow(now, timeZone)}`];
  const profile = formatUserContext(context);
  if (profile) {
    lines.push(`USER CONTEXT (from the user's settings, not from memory — never cite): ${profile}`);
  }
  if (options.language) {
    lines.push(`LANGUAGE: ${formatLanguageRule(context)}`);
  }
  return lines.join('\n');
}
