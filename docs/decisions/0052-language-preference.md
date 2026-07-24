# 0052 — Language preference: anchor, mirroring, and strict mode

Date: 2026-07-24. Status: accepted. Context: P6.6 instance context (issue
#237). Rides migration 0029 (decision 0051). See
`docs/notes/instance-context.md`.

## Context

Cogeto is bilingual by corpus (en + hr golden sets) but had no stored language
preference: replies followed the question's language by prompt convention, and
everything Cogeto initiates — the digest, attention lines, conclusion
phrasing — was hardcoded English.

## Decision

### The model

`preferred_language` is a per-user locale code on `user_context` (initial set:
`en`, `hr`; extensible), plus an opt-in `language_strict` boolean. Defaults:
`en`, mirroring on, strict off.

**This field is deliberately the future key for UI internationalisation**: the
UI remains English for now, but the preference is per-user and
session-available to the SPA (`useUserContext` / `usePreferredLanguage` in
`project/web/src/user-context.ts`), so translation can hang off it later
without a second plumbing pass.

### Three rules

(a) **Anchor** — everything Cogeto INITIATES speaks `preferred_language`: the
daily digest (consolidation + task lines), dashboard attention lines,
conclusion-memory phrasing, and the deterministic zero-answer chat replies
("nothing on record" / "nothing open" — a deterministic string cannot mirror,
so it follows the anchor). Task titles are the deriving memory's content
verbatim (0013 ruling 2) — already in the user's own language, nothing to
translate.

(b) **Mirroring** — direct replies mirror the user's message language by
default, with `preferred_language` as the tie-breaker for mixed or ambiguous
input. Stated by the `LANGUAGE` line the context block (0051) carries into
answer-tier calls; detection stays what the model does naturally under that
instruction — no separate language-detection service.

(c) **Strict mode** — "always answer in my language": replies always come
back in `preferred_language` regardless of the input language.

### Implementation shape

- Model-called paths get the rule via the `LANGUAGE` line (answer/v0006,
  research_answer/v0003).
- Deterministic paths stay deterministic: the digest builders
  (`dream-digest.ts`, `tasks-digest.ts`), attention titles
  (`attention.service.ts`), and conclusion phrasing (`task-conclusion.ts`)
  carry en/hr string tables and take the owner's locale — 0037 ruling 4 ("no
  model in the conclusion path") is untouched. Translation may never reorder
  or drop digest lines: the attention feed's dismissal keys index into the
  line order.
- System-initiated callers resolve the locale through
  `UserContextService.preferredLanguageFor(ownerId)`; any read failure falls
  back to English rather than blocking the path.
- The demo persona (Ana) is seeded with `preferred_language: 'hr'` through
  the real settings endpoint, so the sandbox digest demonstrates the anchor.

### Evaluation

Two golden chat cases join the corpus: `strict_mode_hr` (an ENGLISH question
must come back Croatian under strict mode — judged by a deterministic
diacritics + stopword balance) and `digest_hr_preferred` (a real dreaming
cycle in the harness; the digest lines must exist and speak Croatian). Both
fold into the all-must-pass `conversation` rule verdict. Unit specs:
`initiated_content_in_preferred` (digest tables), `mirroring_default`,
`strict_mode`, `tiebreak_mixed` (LANGUAGE-line assertions),
`task-conclusion-locale.spec.ts`.

## Consequences

- An hr user's instance finally SPEAKS Croatian where Cogeto starts the
  conversation, without a translation service, a model call on deterministic
  paths, or a UI rewrite.
- Adding a language = extending `SUPPORTED_LANGUAGES`, the string tables, and
  the eval corpus for that language; the gate ratchet (eval §6) applies.
- The UI stays English until a deliberate i18n pass; the key it will hang off
  already exists and is already per-user.
