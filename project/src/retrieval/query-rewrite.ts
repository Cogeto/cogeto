import { z } from 'zod';
import { resolveExpression } from '../ingestion/index';
import { loadPrompt, ModelGateway } from '../model-gateway/index';
import type { PromptArtifact } from '../model-gateway/index';
import { queryEntityCandidates } from './query-entities';
import { REWRITE_TIMEOUT_MS } from './retrieval-config';

/**
 * Conversational query rewriting (decision 0007 ruling 4; F3) + temporal
 * intent (decision 0012 ruling 2; F3-A) + the conversational router's
 * question class (decision 0046). One bounded model call resolves
 * pronouns/ellipsis into a self-contained query and classifies temporal
 * intent — but temporal is DOUBLE-GUARDED deterministically: the model is
 * consulted for it only when the raw question carries a temporal hint, and a
 * classification without a hint is discarded. Dates are resolved by the S3.5
 * chrono resolver, never by the model. Any failure → default mode ('personal'
 * question class — the memory-question path), never an error.
 */
export const QUERY_REWRITE_PROMPT = { family: 'query_rewrite', version: 'v0005' } as const;

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type TemporalIntentKind = 'previous' | 'point_in_time' | 'change_since';

export interface TemporalIntent {
  kind: TemporalIntentKind;
  /** Resolved instant for point_in_time (deterministic, chrono-anchored to now). */
  at?: Date;
  /** Resolved window start for change_since. */
  since?: Date;
}

export interface OpenLoopsIntent {
  /** Entity-scoped variant ("what's open with Luka"); null = everything open. */
  entity: string | null;
}

/** Draft-a-reply intent (Session O4 — email reply triggers). */
export interface EmailReplyIntent {
  /** The named person/sender to reply to; null = "reply to that/the last one". */
  target: string | null;
}

/**
 * The router's question class (decision 0046): what kind of turn this is.
 * - `personal` — a question about the user's own world; memory answers it
 *   (the default, and the fallback on every classification failure).
 * - `knowledge` — a question about the wider world, answerable from general
 *   knowledge; memory still retrieves and grounds first (memory-first), the
 *   model's own knowledge supplements — marked — and the research offer rides
 *   along.
 * - `smalltalk` — greetings, thanks, and meta-questions about Cogeto itself;
 *   a natural brief reply, no retrieval theatre.
 */
export type QuestionClass = 'personal' | 'knowledge' | 'smalltalk';

export interface RewriteResult {
  query: string;
  /** Entities the query is about, from the rewriter or the heuristic fallback. */
  entities: string[];
  /** Temporal intent (decision 0012 ruling 2); null = default retrieval. */
  temporal: TemporalIntent | null;
  /** Open-loops intent (decision 0013 ruling 7); null = default retrieval. */
  openLoops: OpenLoopsIntent | null;
  /** Draft-a-reply intent (Session O4); null = not a reply request. */
  emailReply: EmailReplyIntent | null;
  /** The router's question class (decision 0046); 'personal' on any failure. */
  questionClass: QuestionClass;
}

const rewriteSchema = z.object({
  rewritten_query: z.string().min(1),
  entities: z.array(z.string()).default([]),
  temporal: z
    .object({
      kind: z.enum(['previous', 'point_in_time', 'change_since']),
      /** The temporal phrase VERBATIM ("in March", "od lipnja") — code resolves it. */
      expression: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  open_loops: z
    .object({ entity: z.string().nullable().default(null) })
    .nullable()
    .default(null),
  question_class: z.enum(['personal', 'knowledge', 'smalltalk']).nullable().default(null),
});

/** Third-person anaphora + demonstratives — first/second person needs no resolution. */
export const ANAPHORA_RE =
  /\b(she|her|hers|he|him|his|it|its|they|them|their|theirs|this|that|these|those)\b/i;

/**
 * The temporal-hint lexicon (decision 0012 ruling 2), en + hr: the enable AND
 * veto guard. Plain questions can never classify temporal — a model claim
 * without a hint in the RAW question is discarded.
 */
export const TEMPORAL_HINT_RE = new RegExp(
  [
    // English
    'previous(ly)?',
    'used to',
    'before',
    'back then',
    'earlier',
    'at the time',
    'originally',
    'history of',
    "what(’|')?s? (has )?changed",
    'what is new since',
    "what('|’)s new",
    'since\\s+(january|february|march|april|may|june|july|august|september|october|november|december|last|\\d)',
    '\\bin\\s+(january|february|march|april|may|june|july|august|september|october|november|december)\\b',
    'last (year|month|quarter|week)',
    // Croatian
    'prije',
    'prošl\\w*',
    'nekad',
    'ranije',
    'u to (vrijeme|doba)',
    'izvorno',
    'što se promijenilo',
    'što je novo',
    'od (siječnja|veljače|ožujka|travnja|svibnja|lipnja|srpnja|kolovoza|rujna|listopada|studenog|prosinca)',
    'u (siječnju|veljači|ožujku|travnju|svibnju|lipnju|srpnju|kolovozu|rujnu|listopadu|studenom|prosincu)',
  ].join('|'),
  'i',
);

/**
 * The open-loops hint lexicon (decision 0013 ruling 7), en + hr — the same
 * enable-and-veto double guard as temporal.
 */
export const OPEN_LOOPS_HINT_RE = new RegExp(
  [
    // English
    'still open',
    'outstanding',
    'pending',
    'waiting (on|for)',
    'open (loops?|items?|tasks?)',
    "what('|’)?s open",
    'what is open',
    'did i promise',
    'do i (still )?owe',
    'commit(ted)? to',
    'follow[- ]ups?',
    'to[- ]dos?',
    // Croatian
    'još otvoreno',
    'otvoren\\w*',
    'neriješen\\w*',
    'čeka\\w*',
    'obeć\\w*',
    'dugujem',
    'obvez\\w*',
    'zadaci|zadatke|zadataka',
  ].join('|'),
  'i',
);

/**
 * Draft-a-reply hint lexicon (Session O4), en + hr. Deliberately anchored on
 * reply/response verbs WITH a target/context so it does not fire on the everyday
 * sense of "answer"/"reply".
 */
export const REPLY_EMAIL_HINT_RE = new RegExp(
  [
    // English
    'draft (a |an )?(reply|response)',
    'write (a |an )?(reply|response)',
    'compose (a |an )?(reply|response)',
    '\\breply to\\b',
    '\\brespond to\\b',
    '\\bresponse to\\b',
    'help me (answer|reply|respond)',
    'answer\\b.{0,40}\\b(email|e-mail|mail|message|msg)\\b',
    // Croatian
    'odgovor\\w* na\\b',
    'odgovori(ti)? na\\b',
    'napiš\\w* odgovor',
    'nacrt odgovora',
    'sastavi odgovor',
  ].join('|'),
  'i',
);

/** Create-a-task intent (decision 0038): the explicit conversational request
 * to turn something into a task ("make a task to…", "remind me to…",
 * "dodaj zadatak: …"). Deterministic like the reply intent — the lexicon both
 * detects the request and extracts the instruction; no model decides WHETHER. */
export interface CreateTaskIntent {
  /** The task instruction with the trigger phrase stripped; null = the
   * trigger fired but carried nothing actionable. */
  instruction: string | null;
  /** Which language's trigger matched — picks the capture normalization. */
  lang: 'en' | 'hr';
}

const CREATE_TASK_PATTERNS: ReadonlyArray<{ lang: 'en' | 'hr'; re: RegExp }> = [
  {
    lang: 'en',
    re: /\b(?:make|create|add|open|set up)\s+(?:me\s+)?a\s+(?:new\s+)?(?:task|to[- ]?do)(?:\s+(?:to|for|about)\s+(.+)|\s*[:–—-]\s+(.+))?\s*$/i,
  },
  { lang: 'en', re: /\bnew task\s*[:–—-]\s*(.+)$/i },
  { lang: 'en', re: /\bremind me to\s+(.+)$/i },
  {
    lang: 'hr',
    re: /\b(?:napravi|kreiraj|dodaj|otvori|stavi)\s+(?:mi\s+)?(?:novi\s+)?zadatak(?:\s+(?:da|za)\s+(.+)|\s*[:–—-]\s+(.+))?\s*$/i,
  },
  { lang: 'hr', re: /\bnovi zadatak\s*[:–—-]\s*(.+)$/i },
  { lang: 'hr', re: /\bpodsjeti me (?:da|na)\s+(.+)$/i },
];

/**
 * The question veto: a turn ASKING about tasks ("did I make a task for
 * Marko?", "imam li zadatak…") is retrieval, not creation. Leading
 * interrogatives that request information veto the intent; polite request
 * forms ("can you make a task to…") deliberately do not.
 */
const CREATE_TASK_QUESTION_VETO =
  /^\s*(?:did|do|does|have|has|had|is|are|was|were|what|which|when|where|why|how|who|jesam|jesi|je\s*li|ima[mš]\s*li|što|sto|koji|koja|koje|kada|kad|gdje|zašto|zasto|kako|tko)\b/i;

/** Detect an explicit create-a-task request. Purely deterministic (no model). */
export function detectCreateTaskIntent(question: string): CreateTaskIntent | null {
  if (CREATE_TASK_QUESTION_VETO.test(question)) return null;
  for (const { lang, re } of CREATE_TASK_PATTERNS) {
    const match = re.exec(question);
    if (!match) continue;
    const raw = (match[1] ?? match[2] ?? '')
      .trim()
      .replace(/[.!?\s]+$/, '')
      .trim();
    return { instruction: raw.length >= 3 ? raw : null, lang };
  }
  return null;
}

export interface ResearchIntent {
  /** The research topic (the turn minus its trigger verb), verbatim. */
  topic: string;
  lang: 'en' | 'hr';
}

/**
 * Explicit research triggers (Priority 5 Part B, decision 0045). Imperative
 * verbs ANCHORED to the start of the turn, so research is invoked, never
 * inferred: an ordinary question — even one about a company or a law — must
 * never reach a search engine on its own (`not_ambient`). "search for" is
 * deliberately paired with web/online/internet qualifiers so "search my notes
 * for…" stays retrieval.
 */
const RESEARCH_PATTERNS: ReadonlyArray<{ lang: 'en' | 'hr'; re: RegExp }> = [
  {
    lang: 'en',
    re: /^\s*(?:please\s+)?(?:research|look\s+up|find\s+out\s+about|search\s+(?:the\s+)?(?:web|online|internet)\s+for)\s+(.+)$/i,
  },
  {
    // `istraži` is the unambiguous research imperative; `potraži`/`pretraži`
    // need the web/internet qualifier (like "search the web for") so
    // "potraži u mojim bilješkama…" stays retrieval.
    lang: 'hr',
    re: /^\s*(?:molim(?:\s+te)?\s+)?(?:istraži|potraži\s+na\s+(?:webu|internetu)|pretraži\s+(?:web|internet)\s+za)\s+(.+)$/iu,
  },
];

/** Detect an explicit research request. Purely deterministic (no model). */
export function detectResearchIntent(question: string): ResearchIntent | null {
  for (const { lang, re } of RESEARCH_PATTERNS) {
    const match = re.exec(question);
    if (!match) continue;
    const topic = (match[1] ?? '')
      .trim()
      .replace(/[.!?\s]+$/, '')
      .trim();
    if (topic.length < 3) return null; // a bare trigger proposes nothing
    return { topic, lang };
  }
  return null;
}

/** A deterministically detected small-talk turn (decision 0046). */
export interface SmallTalkIntent {
  kind: 'thanks' | 'greeting' | 'farewell' | 'ack';
  lang: 'en' | 'hr';
}

/**
 * The small-talk lexicon (decision 0046): pure pleasantries matched as the
 * WHOLE turn only — "thanks!" routes here; "thanks, and who is Ana?" never
 * does. These answer deterministically with no retrieval and no model call;
 * anything past the lexicon is the model classifier's job (with its veto).
 */
const SMALL_TALK_PATTERNS: ReadonlyArray<{
  kind: SmallTalkIntent['kind'];
  lang: 'en' | 'hr';
  re: RegExp;
}> = [
  {
    kind: 'thanks',
    lang: 'en',
    re: /^(?:ok(?:ay)?[,!. ]*)?(?:many\s+)?(?:thanks|thank\s+you|thx|ty|cheers)(?:\s+(?:a\s+lot|so\s+much|again|for\s+(?:that|this|the\s+help)))?\s*$/i,
  },
  {
    kind: 'thanks',
    lang: 'hr',
    re: /^(?:ok[,!. ]*|u\s+redu[,!. ]*)?(?:puno\s+)?hvala(?:\s+(?:ti|vam|lijepa|lijepo|puno|najljepša))*\s*$/iu,
  },
  {
    kind: 'greeting',
    lang: 'en',
    re: /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))(?:\s+there)?\s*$/i,
  },
  {
    kind: 'greeting',
    lang: 'hr',
    re: /^(?:bok|pozdrav|dobro\s+jutro|dobar\s+dan|dobra\s+večer)\s*$/iu,
  },
  {
    kind: 'farewell',
    lang: 'en',
    re: /^(?:bye|goodbye|good\s+night|see\s+you(?:\s+(?:later|tomorrow))?)\s*$/i,
  },
  {
    kind: 'farewell',
    lang: 'hr',
    re: /^(?:doviđenja|dovidenja|vidimo\s+se(?:\s+sutra)?|laku\s+noć)\s*$/iu,
  },
  {
    kind: 'ack',
    lang: 'en',
    re: /^(?:ok(?:ay)?|got\s+it|great|perfect|nice|cool|sounds\s+good|makes\s+sense|understood|that(?:'|’)?s\s+helpful|very\s+helpful)\s*$/i,
  },
  {
    kind: 'ack',
    lang: 'hr',
    re: /^(?:ok|u\s+redu|može|moze|super|odlično|odlicno|savršeno|savrseno|jasno|razumijem)\s*$/iu,
  },
];

/** Detect a pure small-talk turn. Purely deterministic (no model). */
export function detectSmallTalk(question: string): SmallTalkIntent | null {
  const turn = question.trim().replace(/[!.…\s]+$/u, '');
  if (!turn || turn.length > 60) return null;
  for (const { kind, lang, re } of SMALL_TALK_PATTERNS) {
    if (re.test(turn)) return { kind, lang };
  }
  return null;
}

/**
 * The question-class veto guard (decision 0046), same double-guard posture as
 * temporal/open-loops: the model's classification is honored only when nothing
 * deterministic contradicts it. A turn that names a person/organization, or
 * that resolved a temporal/open-loops/reply intent, is never small talk; a
 * turn with a resolved temporal/open-loops intent is never a knowledge
 * question. Everything else falls back to 'personal' — the memory-question
 * path is the default and the failure mode.
 */
export function resolveQuestionClass(
  rawQuestion: string,
  claimed: QuestionClass | null,
  resolved: {
    temporal: TemporalIntent | null;
    openLoops: OpenLoopsIntent | null;
    emailReply: EmailReplyIntent | null;
  },
): QuestionClass {
  if (!claimed || claimed === 'personal') return 'personal';
  if (resolved.temporal || resolved.openLoops || resolved.emailReply) return 'personal';
  if (claimed === 'smalltalk') {
    return queryEntityCandidates(rawQuestion).length > 0 ? 'personal' : 'smalltalk';
  }
  return 'knowledge';
}

/** Captures the reply TARGET (person/sender) after the reply verb. */
const REPLY_TARGET_RE =
  /(?:reply to|respond to|response to|answer|help me (?:answer|reply to|respond to)|odgovor\w* na|odgovori(?:ti)? na)\s+(.+)$/i;

/**
 * Detect a draft-a-reply request and extract the target person/sender. Purely
 * deterministic (no model) — reuses the rewriter's `entities` only as a fallback
 * target. A demonstrative target ("that", "the last one") resolves to null so
 * the resolver picks the most recent email.
 */
export function detectEmailReplyIntent(
  question: string,
  entities: string[] = [],
): EmailReplyIntent | null {
  if (!REPLY_EMAIL_HINT_RE.test(question)) return null;
  const match = REPLY_TARGET_RE.exec(question);
  const rawTarget = match?.[1] ?? null;
  let target = rawTarget ? cleanReplyTarget(rawTarget) : null;
  // A pronoun/demonstrative target normalizes to null BEFORE the entities
  // fallback, so a rewriter-resolved referent ("her" → "Ana Kovač") can fill
  // in (decision 0046 cross-capability follow-ups).
  const pronounTarget = Boolean(
    target && /^(that|this|it|the last( one)?|latest|last|him|her|them)$/i.test(target),
  );
  if (pronounTarget) target = null;
  // The entities fallback applies ONLY to a resolved pronoun (or a bare reply
  // request with no target phrase at all). A target that cleaned to nothing —
  // "zadnju e-poruku", "the last email" — asks for the MOST RECENT email;
  // filling it from heuristic entity candidates once produced a phantom
  // sender ("Napiši", the sentence-initial verb — reply_hr_zadnja).
  if (!target && (pronounTarget || rawTarget === null) && entities.length > 0) {
    target = entities[0]!.trim() || null;
  }
  return { target: target || null };
}

function cleanReplyTarget(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[.?!]+$/, '')
    .replace(/['’]s\b.*$/, '') // "Ana's last email" → "Ana"
    .replace(/\b(last|latest|recent|zadnj\w*|posljednj\w*)\b/gi, '')
    // The joined Croatian "e-poruka" (and e-mail/email) must strip WHOLE —
    // a surviving "e-" remnant once became a phantom sender the resolver
    // searched for (issue #78; the live gate caught it on reply_hr_zadnja).
    .replace(/\b(?:e[- ]?)?(mail|message|msg|note|poruk\w*|mejl\w*)\b/gi, '')
    .replace(/^(the|that|this|a|an)\s+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // A remnant of only punctuation/hyphens is no target at all — "no named
  // sender" correctly resolves to the most recent email downstream.
  return /^[\s\-–—'’"]*$/.test(cleaned) ? '' : cleaned;
}

/**
 * Rewrite when the turn leans on context (anaphora / terse follow-up) OR
 * carries a temporal, open-loops, or reply hint — intent classification needs
 * the model even for otherwise self-contained questions.
 */
export function shouldRewrite(question: string): boolean {
  const words = question.trim().split(/\s+/).filter(Boolean);
  return (
    words.length <= 3 ||
    ANAPHORA_RE.test(question) ||
    TEMPORAL_HINT_RE.test(question) ||
    OPEN_LOOPS_HINT_RE.test(question) ||
    REPLY_EMAIL_HINT_RE.test(question)
  );
}

/** The open-loops veto guard: no hint in the raw question, no tasks mode. */
export function resolveOpenLoopsIntent(
  rawQuestion: string,
  claimed: { entity: string | null } | null,
): OpenLoopsIntent | null {
  if (!claimed) return null;
  if (!OPEN_LOOPS_HINT_RE.test(rawQuestion)) return null;
  const entity = claimed.entity?.trim() || null;
  return { entity };
}

/**
 * Deterministic resolution of the model's classification (ruling 2): the veto
 * guard, then chrono for dates. point_in_time without a resolvable date and
 * change_since without a resolvable start both fall back to default mode.
 */
export function resolveTemporalIntent(
  rawQuestion: string,
  claimed: { kind: TemporalIntentKind; expression: string | null } | null,
  now: Date = new Date(),
  timeZone?: string,
): TemporalIntent | null {
  if (!claimed) return null;
  if (!TEMPORAL_HINT_RE.test(rawQuestion)) return null; // veto: no hint, no mode
  if (claimed.kind === 'previous') return { kind: 'previous' };
  const raw = claimed.expression ? resolveExpression(claimed.expression, now, timeZone) : null;
  const resolved = raw ? toMostRecentPast(raw, now) : null;
  if (!resolved) return null; // unresolvable date → default mode, never an error
  return claimed.kind === 'point_in_time'
    ? { kind: 'point_in_time', at: resolved }
    : { kind: 'change_since', since: resolved };
}

/**
 * The S3.5 resolver prefers FORWARD dates (it was built for deadlines — "by
 * Monday"); temporal queries look BACKWARD ("in March" asked in July means
 * last March). Policy, not a second date engine: a future resolution steps
 * back one year; still future → unresolvable.
 */
function toMostRecentPast(resolved: Date, now: Date): Date | null {
  if (resolved.getTime() <= now.getTime()) return resolved;
  const stepped = new Date(resolved);
  stepped.setFullYear(stepped.getFullYear() - 1);
  return stepped.getTime() <= now.getTime() ? stepped : null;
}

function buildRewriteInput(
  history: ConversationTurn[],
  question: string,
  contextBlock?: string,
): string {
  const turns = history.length
    ? history.map((t) => `${t.role}: ${t.content}`).join('\n')
    : '(none)';
  // Deterministic subject assist (decision 0046): the names the USER has
  // raised in their own turns. A pronoun's referent is almost always one of
  // these — a person who appears only inside assistant answers (a mentioned
  // subcontractor, a recipient) does not capture the pronoun. Computed by the
  // same capitalized-token heuristic as retrieval's entity signal; a noisy
  // candidate is harmless (the prompt treats these as candidates, not truth).
  const userNamed = [
    ...new Set(
      history.filter((t) => t.role === 'user').flatMap((t) => queryEntityCandidates(t.content)),
    ),
  ].slice(0, 8);
  return [
    // The now-block (P6.6, decision 0051): interpretation only — the prompt
    // reiterates that dates stay verbatim and context never invents entities.
    ...(contextBlock ? [contextBlock, ''] : []),
    'RECENT TURNS:',
    turns,
    '',
    `USER-NAMED ENTITIES (names the user has raised themself): ${userNamed.join(', ') || '(none)'}`,
    '',
    'QUESTION:',
    question,
  ].join('\n');
}

export interface RewriteOptions {
  /**
   * Run the model classification even for turns `shouldRewrite` would skip
   * (decision 0046): the chat router needs the question class on every turn —
   * a self-contained knowledge question carries no lexical hint. Non-chat
   * callers keep the cheap gating.
   */
  alwaysClassify?: boolean;
  /**
   * The rendered now-block (P6.6, decision 0051), prepended to the rewriter
   * input. Interpretation-only by prompt contract; date resolution stays in
   * the deterministic resolver via the `now`/`timeZone` parameters.
   */
  contextBlock?: string;
}

/**
 * Returns a self-contained query + entities. Uses the model when the turn needs
 * it; otherwise (and on any failure/timeout) falls back to the raw query with
 * heuristic entity candidates — the fast path never blocks on the rewriter.
 */
export async function rewriteQuery(
  gateway: ModelGateway,
  history: ConversationTurn[],
  question: string,
  loadPromptFn: typeof loadPrompt = loadPrompt,
  now: Date = new Date(),
  timeZone?: string,
  options: RewriteOptions = {},
): Promise<RewriteResult> {
  const fallback: RewriteResult = {
    query: question,
    entities: queryEntityCandidates(question),
    temporal: null,
    openLoops: null,
    emailReply: detectEmailReplyIntent(question, queryEntityCandidates(question)),
    questionClass: 'personal',
  };
  if (!options.alwaysClassify && !shouldRewrite(question)) return fallback;

  try {
    const prompt: PromptArtifact = await loadPromptFn(
      QUERY_REWRITE_PROMPT.family,
      QUERY_REWRITE_PROMPT.version,
    );
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), REWRITE_TIMEOUT_MS),
    );
    const call = gateway.extractStructured(rewriteSchema, {
      system: prompt.content,
      input: buildRewriteInput(history, question, options.contextBlock),
      tier: 'pipeline',
    });
    const result = await Promise.race([call, timeout]);
    if (!result) return fallback; // timed out
    const entities = result.entities.map((e) => e.trim()).filter(Boolean);
    const resolvedEntities =
      entities.length > 0 ? entities : queryEntityCandidates(result.rewritten_query);
    // Veto guard + deterministic date resolution (decision 0012 ruling 2).
    const temporal = resolveTemporalIntent(question, result.temporal, now, timeZone);
    const openLoops = resolveOpenLoopsIntent(question, result.open_loops);
    // Deterministic — detected from the raw question; the rewriter's entities
    // (which resolve anaphora) improve the target fallback (Session O4).
    const emailReply = detectEmailReplyIntent(question, resolvedEntities);
    return {
      query: result.rewritten_query.trim() || question,
      entities: resolvedEntities,
      temporal,
      openLoops,
      emailReply,
      // The router's class, deterministically vetoed (decision 0046).
      questionClass: resolveQuestionClass(question, result.question_class, {
        temporal,
        openLoops,
        emailReply,
      }),
    };
  } catch {
    return fallback;
  }
}
