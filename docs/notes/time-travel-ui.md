# Time-travel diff UI (Session O5 — the visual surface over temporal retrieval)

F3-A ([decision 0012](../decisions/0012-temporal-retrieval-rulings.md)) shipped the
temporal **retrieval engine**: the one interval predicate, explicit temporal-mode
classification (`previous` / `point_in_time` / `change_since`), the `pointInTime`
and `changesSince` primitives, and the past-belief data contract. Chat already
answers temporal questions from it. This unit builds the **visual surface** over
that engine — a subject's honest, inspectable past — with **no new retrieval
semantics and no schema change**. Every temporal view is presentation and
interaction over the existing primitives.

## What shipped

### 1. A thin read composition (memory module)

`TimelineService` (`project/src/memory/timeline.service.ts`) assembles the visual
surface from the MemoryStore's own Principal-gated primitives — it touches no
table and invents no query:

- **`forSubject(principal, subject)`** → the subject's full history as validity
  **spans**. Backed by `listForPrincipal({ entity, includeSensitive })`, so it
  returns facts in **any** lifecycle status (the past is the point), gated, newest
  effective-from first. Each span carries its interval bounds, `superseded_by`,
  the `pastBelief` flag, and a `current` flag.
- **`pointInTime(principal, subject, at)`** → the subject **as understood then**,
  via the *same* `store.pointInTime` primitive a temporal chat answer retrieves
  through, narrowed to the subject and intersected with the subject's own facts so
  the primitive's empty-narrowed recall fallback can never bleed unrelated facts
  into a subject timeline. Each held fact is labelled with its **later fate**
  (`still_current` / `replaced` / `outdated` / `expired`).
- **`diff(principal, subject, from, to)`** → two `pointInTime` snapshots run
  through the pure `computeTimelineDiff` (added / changed / removed / unchanged).

`TimelineController` exposes three Principal-gated reads: `GET /api/timeline`,
`GET /api/timeline/at`, `GET /api/timeline/diff`. Zod at the boundary; cited shared
facts are attributed to their owner (O2-B), name-only.

**Gates hold in every temporal view, at every point in time.** The scope and
sensitive hard gates live inside `visibleTo` in the MemoryStore SQL, which every
primitive the service calls builds on — temporal never weakens a hard gate
(decision 0012 ruling 3). `point_in_time_view_gated` proves another user's private
and sensitive facts never appear, at any instant, in either direction.

### 2. The one predicate is never re-encoded

"Holds at t" is decided **once**, by `pointInTime`'s shared SQL predicate
([ruling 1](../decisions/0012-temporal-retrieval-rulings.md)). The timeline never
hand-rolls it: the span's `current` flag reuses the pure twin `intervalHoldsAt`,
`pastBelief` reuses `isPastBelief`, and the point-in-time / diff readings go
through `store.pointInTime` itself. Displaying an interval's bounds
(`effectiveFrom = valid_from ?? created_at`) is presentation, not a holds-at-t
evaluation.

### 3. Shared, model-free framing (`project/shared/src/timeline.ts`)

The DTOs plus two pure, testable helpers:

- **`computeTimelineDiff`** — set arithmetic over the two gated snapshots, so the
  diff is a data contract, not a prompt hope. Supersession is followed forward
  through `superseded_by`; an intermediate version that held at neither instant
  resolves to `removed` + `added` (the honest reading of "we can't see the
  middle"), never a phantom change.
- **`laterFateOf`** — the past-framing twin (decision 0012 ruling 6), the same
  replaced/outdated/closed shape the chat citation chip already renders.

No model call anywhere in this feature — the whole surface is deterministic.

### 4. The timeline UI (`project/web`)

`TimelineView` renders three readings, reusing the O3 design system (status chips,
the muted "past" variant, cards, empty/error/skeleton states) — **no new visual
vocabulary**:

- **Timeline** — each fact's life as a span on a rail. A currently-held fact is
  teal and distinct; a past one is muted and links "→ what replaced it" to its
  successor. Clicking any fact opens the governance drawer, where its
  verification, provenance and **source are one click away**.
- **At a date** — a date control moves to an instant and shows the subject as
  Cogeto understood it then, including facts since replaced, each labelled with
  what happened to it later.
- **Compare two dates** — the diff phrased in past-belief terms: _"In {March} —
  'Atlas costs 100 EUR'. By {June}, a note changed it to 'Atlas costs 120 EUR'."_
  Plus "what you learned" and "what became outdated". A dense history with no
  change shows a calm current state, not an apology.

Reachable in the two natural places:

- **Entity / memory context** — the memory drawer's entity chips time-travel that
  subject, and its History panel opens the full timeline **at this fact's instant**
  (`?mode=at&at=<valid_from>`).
- **Dashboard view** — the `/timeline` page (nav: "Time travel") answers explicit
  temporal questions visually: type a subject, pick a reading.

### 5. Consistency with chat — two views of one truth

The timeline and chat are two views of the same engine, not two implementations:

- A temporal chat citation opens the governance drawer, which opens the timeline
  **at the relevant point** (the fact's `valid_from`).
- The compare view's "Explain this change in chat →" hands off to `/chat?q=…` with
  the question ready (never auto-sent).
- `ui_matches_chat` proves the timeline's point-in-time facts are exactly the set
  the primitive chat answers from (`store.pointInTime`), with the past-framing
  contract agreeing across both.

## Tests

- `timeline_assembly` — a seeded supersession chain returns the correct ordered
  spans with successors and sources.
- `point_in_time_view_gated` — the temporal view never shows another user's
  private or sensitive facts, at any instant, in either direction.
- `diff_between_points` — added / changed / removed / unchanged are correct
  (integration end-to-end and the pure `computeTimelineDiff` unit matrix,
  including the unseen-intermediate edge).
- `ui_matches_chat` — the same subject yields consistent facts in the timeline and
  in the primitive a temporal chat answer uses.

Plus `laterFateOf` unit cases for the past-framing twin. No prompt, model, or
pipeline change → the golden-set eval gate is untouched.

## Demo (owner checklist)

Seed a supersession about a subject (e.g. via the demo corpus, or capture two
notes: "Atlas costs 100 EUR" then edit it to "Atlas costs 120 EUR"), then:

1. **Open a timeline.** Nav → **Time travel** → type the subject → _View history_.
   The current price is teal and distinct; the old one is muted "past" and links
   "→ what replaced it". (Or: open the memory in Memories, drawer → History →
   "Open timeline for {subject}".)
2. **Move through time.** _At a date_ → pick a date before the change. You see the
   old belief, labelled "later replaced", with a one-click link to its successor
   and its source.
3. **Read a diff.** _Compare two dates_ → a date before and a date after the
   change. Read: _"In {before} — 'Atlas costs 100 EUR'. By {after}, a note changed
   it to 'Atlas costs 120 EUR'."_ Follow "Explain this change in chat →" and
   confirm chat tells the same story.
4. **Check the gates.** As a second user, confirm another member's private /
   sensitive facts never appear in the timeline at any date.

Five required checks green (`lint`, `boundaries`, `test`, `build`, `eval-gate`).
No release tag — the owner cuts releases.
