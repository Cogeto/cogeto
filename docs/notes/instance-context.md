# Instance context and time awareness (P6.6)

Delivered 2026-07-24 (issues #236/#237/#238, decisions 0051/0052/0053,
migration 0029, prompts answer/v0006 + query_rewrite/v0005 +
research_answer/v0003 + context_suggest/v0001). The model gains what it
silently lacked: the current date and time in the right timezone, who the user
is, and which language Cogeto should speak.

## The context model (decision 0051)

Per-user settings on `user_context` (infrastructure-owned, like
`attention_state`; `UserContextService` is a global module and the only
writer): `display_name`, `company`, `role_title`, `about_work`, `timezone`
(per-user IANA override; NULL = the instance timezone from QS-32),
`preferred_language` + `language_strict`, and per-field suggestion provenance.
Settings → "Profile & context"; API `GET/PUT /api/settings/context`.

**The now-block**: `buildContextBlock` (infrastructure) renders

```
NOW: Thursday, 2026-07-24, 14:32 (Europe/Zagreb)
USER CONTEXT (from the user's settings, not from memory — never cite): The user is Ivan, CTO at MVT Solutions. About their work: …
LANGUAGE: answer in the language of the user's message; when it is mixed or ambiguous, use Croatian
```

Unset fields are ABSENT (nothing set → NOW line only); the rewriter gets no
LANGUAGE line (JSON output). Receivers: chat answer + model smalltalk
(answer/v0006), the router/rewriter (query_rewrite/v0005), research synthesis
(research_answer/v0003). Conversational dates ("next Thursday") keep resolving
in the DETERMINISTIC chrono resolver, now anchored to the user's effective
timezone.

**The honesty rule** (frozen in answer/v0006): context informs interpretation
and phrasing but is never a citable fact — no `[F#]`, no `[U]`; a question
about the context itself is answered "You've set … in Settings" in words;
provided facts always beat context; absent context is behaviorally invisible.
One deliberate change: with profile context set, the zero-retrieval
short-circuit yields to a model call (the settings are provided ground);
without profile context the deterministic constant is unchanged.

## The language rules (decision 0052)

- **Anchor**: everything Cogeto initiates speaks `preferred_language` — the
  digest (consolidation + task lines), attention titles, conclusion phrasing,
  and the deterministic zero-answer chat strings. All via en/hr string tables,
  still deterministic (0037 ruling 4 intact). Translation never reorders
  digest lines (dismissal keys index into the order).
- **Mirroring** (default): replies mirror the user's message language;
  `preferred_language` breaks ties on mixed/ambiguous input. Stated by the
  LANGUAGE line; no language-detection service.
- **Strict mode** (opt-in): replies always in `preferred_language`.

Defaults: en, mirroring on, strict off. The demo persona Ana is seeded hr
through the real settings endpoint, so the sandbox digest speaks Croatian.

## The i18n precondition (stated intent)

`preferred_language` is deliberately the future key for UI
internationalisation: the UI remains English for now, but the field is
per-user and session-available (`useUserContext` / `usePreferredLanguage` in
`project/web/src/user-context.ts`), so translation can hang off it later
without a second plumbing pass.

## Derived suggestions (decision 0053)

Deterministic first-person candidate rules over the user's own memories + one
pipeline-tier confirmation (context_suggest/v0001, confirm-or-reject only)
propose `company`/`role_title` when the field is unset and evidence is
unambiguous. Settings shows the suggestion with its source memory; accept is
audited and provenance-linked; dismiss is remembered per (field, value);
explicit user values are never overridden or re-derived.

## Tests and evals

- `infrastructure/context-block.spec.ts` — empty_fields_absent, block shape,
  language-rule wording.
- `retrieval/chat/instance-context.integration.spec.ts` — now_block_injected
  (user tz beats instance tz in rewriter AND answer inputs),
  empty_fields_absent (chat-level), context_not_cited, mirroring_default,
  strict_mode, tiebreak_mixed, localized deterministic replies.
- `ingestion/domain/temporal-user-timezone.spec.ts` —
  conversational_dates_resolve ("next Thursday" per zone, deterministic).
- `ingestion/dream-digest-locale.spec.ts` + `tasks/task-conclusion-locale.spec.ts`
  — initiated_content_in_preferred.
- `connectors/context-suggestions.spec.ts` — suggestion_conservative,
  suggestion_provenance, suggestion_respects_user.
- Golden chat cases `strict_mode_hr` and `digest_hr_preferred` (the harness
  gained per-case `settings`, a deterministic `language` check, and a
  `digest_language` check that runs a REAL dreaming cycle).

## Gotchas for future sessions

- Prompt-input assembly is code, not templates: the block is prepended by
  `buildAnswerInput`/`buildRewriteInput`/the research input string — a new
  receiving surface must call `buildContextBlock` itself, never re-phrase.
- `AttentionService` now REQUIRES `UserContextService` (6th ctor arg); the
  chat/tasks/research services take it `@Optional()` so bare harness
  constructions stay valid.
- Ingestion note-anchoring keeps the INSTANCE timezone (a note's calendar
  date is an instance-level fact); only chat-path resolution uses the user
  override.
- The eval harness applies per-case settings through the real
  `UserContextService`; remember cases run alphabetically in ONE database —
  the `digest_hr_preferred` dream cycle runs after earlier cases have already
  been scored, so it cannot disturb them.
