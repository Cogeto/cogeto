# 0051 — Instance context: user settings and the now-block

Date: 2026-07-24. Status: accepted. Context: P6.6 instance context and time
awareness (issue #236). Migration 0029; prompts answer/v0006,
query_rewrite/v0005, research_answer/v0003. See
`docs/notes/instance-context.md`.

## Context

The model has silently lacked three things every human assistant has: the
current date and time in the right timezone, who the user is, and (0052) which
language to speak. Chat resolved relative dates against the INSTANCE timezone
only (QS-32), the answerer had no idea what day it was, and "my company" meant
nothing. All of it had to arrive without violating the verifiable-memory
thesis: context is not memory and must never masquerade as it.

## Decision

### The context model — per-user settings

One row per user in `user_context` (migration 0029), owned by
**infrastructure**, not a domain module: the context feeds prompts and copy in
retrieval, connectors, ingestion, tasks and the entrypoints alike, so no
bounded context owns it — the same rationale as `audit_log` and
`attention_state` (§A.1 rule 2). `UserContextService` (a global module, like
LimitsModule) is the only writer; every update is audited with STRUCTURAL
detail only (field names, language/timezone codes — never profile text).

Fields, all optional except the language pair (0052): `display_name`,
`company`, `role_title`, `about_work` (one free-text line), `timezone` (a
per-user IANA override; NULL = the instance timezone from QS-32 applies —
Settings surfaces the effective zone), `preferred_language` +
`language_strict` (decision 0052), and two provenance columns
(`company_source_memory_id`, `role_title_source_memory_id`) for accepted
suggestions (decision 0053). Editable in Settings under "Profile & context";
served by `GET/PUT /api/settings/context`.

### The now-block

Every answer-tier and rewriter call gains a small labeled context block,
assembled in ONE place (`buildContextBlock` in infrastructure) and prepended
to the model input by the existing input builders:

- `NOW: <weekday>, <YYYY-MM-DD>, <HH:mm> (<zone>)` — always present, in the
  user's EFFECTIVE timezone (user override, else instance).
- `USER CONTEXT (from the user's settings, not from memory — never cite): …`
  — the set fields phrased plainly ("The user is Ivan, CTO at MVT Solutions.
  About their work: …"). **Unset fields are ABSENT** — no "company: unknown",
  no placeholders. Nothing set → the block is the NOW line only.
- `LANGUAGE: …` — the reply-language rule (decision 0052). Omitted for the
  rewriter, whose output is JSON.

Receivers: the chat answer and model-smalltalk calls (answer/v0006), the
router/rewriter call (query_rewrite/v0005), and research synthesis
(research_answer/v0003). The rewriter's contract is unchanged where it
matters: date phrases are still copied VERBATIM and resolved by the
deterministic chrono resolver (0007 ruling 1, 0012 ruling 2) — now anchored to
the user's effective timezone, so conversational "next Thursday" resolves in
the user's calendar. USER CONTEXT additionally lets the rewriter resolve a
self-reference ("my company", "moja tvrtka") to the set value.

### The honesty rule — context informs, never sources

Frozen in answer/v0006:

1. Context shapes interpretation and phrasing (relative dates, addressing the
   user, what "my company" means) but is **never a citable fact**: no `[F#]`
   (it is not a provided fact) and no `[U]` (it is not model knowledge).
2. Context is **never presented as remembered.** "Where do I work?" answers
   from memory with citations when memory covers it — facts always win; when
   only the settings know, the answer names its origin in words ("You've set
   MVT Solutions as your company in Settings") with no citation chip and
   never a fabricated memory citation.
3. **Absent context is invisible**: behavior with no fields set is exactly the
   pre-P6.6 behavior; the model never remarks on unset fields.

One deliberate behavior change: the zero-retrieval short-circuit (the
deterministic "nothing on record" string) now yields to a model call **when
profile context is set** — the settings are provided ground, so a
context-question deserves the honest settings answer instead of a false
"nothing". With no profile set, the deterministic path is byte-identical to
before.

## Consequences

- One assembly point: no surface invents its own context phrasing; tests pin
  the block shape (`context-block.spec.ts`, `instance-context.integration.spec.ts`,
  `temporal-user-timezone.spec.ts`).
- The rewriter/answer prompt bumps ride the normal versioning discipline
  (immutable artifacts, changelogs, eval-gated).
- Per-user timezone is settings-only; ingestion's note anchoring keeps the
  instance timezone (a note's calendar date is an instance-level fact — QS-32
  unchanged).
- Context values never enter retrieval, embeddings, or the memory store; the
  citation sanitizer guarantees a context statement cannot acquire a chip.
