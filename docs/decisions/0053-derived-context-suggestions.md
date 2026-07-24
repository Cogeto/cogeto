# 0053 — Derived context suggestions with confirmation

Date: 2026-07-24. Status: accepted. Context: P6.6 instance context (issue
#238). Rides migration 0029 (decision 0051); prompt family
context_suggest/v0001. See `docs/notes/instance-context.md`.

## Context

Cogeto often already knows the user's company or role from their own memories
("I work at MVT Solutions…"). Asking the user to retype into Settings what
the instance verifiably knows is friction; silently applying it would blur the
line decision 0051 draws between settings and memory.

## Decision

A conservative derivation loop proposes values for `company` and `role_title`
ONLY when confidence is high and the field is unset — never silently applied,
never re-derived over an explicit user value.

- **Derivation** (`ContextSuggestionsService`, connectors): deterministic
  candidate rules (first-person en/hr patterns — "I work at…", "radim u…",
  "ja sam…") over the user's OWN active/user-approved memories (an
  entity-profile-style gathered read, owner-gated, newest first; past-tense
  or hypothetical phrasing vetoes the memory). A field with more than one
  distinct candidate value produces NO suggestion — conflicting evidence is
  silence, not a guess.
- **Confirmation**: ONE pipeline-tier call (context_suggest/v0001) that can
  only confirm or reject the deterministic candidates — never invent or
  rewrite a value; unsure means rejected; a gateway failure proposes nothing.
- **The Settings surface** shows each suggestion with its source: "It looks
  like you work at MVT Solutions (from your note of 12 May). Use as
  context?". Accept sets the field through
  `UserContextService.applySuggestion` — audited
  (`context.suggestion_accepted`, detail `{ field, derivedFromMemoryId }` —
  structural ids only) and provenance-linked on the row
  (`company_source_memory_id` / `role_title_source_memory_id`). Dismiss is
  remembered in `context_suggestion_dismissal` (field + normalized value) and
  the same value is never re-proposed.
- **User values win forever**: a set field is never re-derived; a user-typed
  edit clears the suggestion provenance (the value is theirs now).
- Endpoints: `GET /api/settings/context/suggestions`, `POST …/accept`,
  `POST …/dismiss`. Computation happens on the Settings read — explicitly
  user-initiated, bounded (200 newest memories, one pipeline call), never
  ambient.

## Consequences

- The trust boundary holds: what the user sees in Settings is either typed by
  them or accepted by them, with inspectable provenance either way.
- Tests pin the conservatism: `suggestion_conservative` (conflict or
  unconfirmed → nothing), `suggestion_provenance` (accepted value records its
  memory), `suggestion_respects_user` (set/dismissed values never return).
- The pattern extends to future fields (timezone from travel notes was
  deliberately NOT included — too low confidence) by adding a field to the
  candidate rules and the dismissal enum.
