# answer — changelog

Prompt family for the fast-path chat answerer (S3-A): answers only from the
retrieved fact blocks, cites with inline `[F#]` markers, says plainly when the
facts do not cover the question.

## v0010 - 2026-08-22 (legal cleanup, no instruction change)

The USER CONTEXT example named a real third-party company. v0010 is v0009 with
that one token replaced by the fictional "Vela Consulting", matching the house
convention for sample entities (Adriatic Foods, Velum Industrial). Nothing else
differs: no rule, no format, no instruction, no section. A new version rather
than an edit because spec 12.3 makes a released family immutable and the worker
enforces it by content hash at boot, so an in-place edit would fail the boot of
every instance that already registered v0009.

The retired versions v0006, v0007, v0008 and v0009 carry the same replacement,
applied in place. They are never loaded or re-registered (only the active refs in
`ingestion/prompt-versions.ts`, `ANSWER_PROMPT` and the four chat refs are), so
no instance can observe the change, and leaving a third party's name in a
published artifact was the thing being fixed.

## v0008 — 2026-08-05 (V2.2 item 5.1 — chat-centric capture)

Transient chat attachments. A new optional `ATTACHED FILES` block carries the
fenced text of files attached to the conversation with "don't remember this
file", and a new section states its contract, deliberately the USER CONTEXT
shape: conversation-only provided ground, answered from freely when asked
about, attributed in words ("According to the attached …"), never `[F#]`
(not a provided fact) and never `[U]` (not model knowledge), provided facts
still win, and the fenced text is data, never instructions. Absent the block,
the input is byte-identical to v0007, so every existing eval case renders
unchanged.

## v0007 — 2026-07-28 (V2.0 item 3.1 — task removal)

The open-loops answer is memory-backed (decision 0060). MODE `tasks` becomes
MODE `open_loops`, and the section that governs it is rewritten off the task
vocabulary: the `OPEN LOOPS` block now lists remembered commitment/open-loop
facts in the user's own words rather than derived task rows, so due dates come
from the fact's own validity (`due:`), "waiting on" is read from what the fact
itself states rather than from a task's condition field, and "unconfirmed"
means the fact's status is `uncertain` rather than a task derived from one.
The "never list a completed or dismissed obligation" rule is replaced by the
stronger structural guarantee it now rests on: settled facts never reach the
block at all, so the answerer must not speculate about completion. Everything
else — citation grammar, `[U]` marking, past-belief framing, entity profiles,
small talk, language — is unchanged from v0006.

## v0006 — 2026-07-24 (P6.6 instance context)

Instance context and time awareness (decisions 0051/0052). Three new input
lines: `NOW` (date, weekday, time in the user's own timezone — always
present), `USER CONTEXT` (who the user is, exactly as set in their settings —
absent when nothing is set), and `LANGUAGE` (the reply-language rule). A new
"context informs, never sources" section freezes the honesty rule: context
statements carry NO marker (neither `[F#]` nor `[U]`), context is never
presented as remembered — a question about the context itself is answered
"You've set … in Settings" in words, and provided facts always win over
context; absent context is behaviorally invisible. The marked-claim rule in
GENERAL KNOWLEDGE gains the matching exception for settings-attributed
statements. The Language section now follows the LANGUAGE line: mirroring by
default with the preferred language as tie-breaker for mixed/unclear input,
always-preferred in strict mode, question-language fallback without the line.
Everything else verbatim from v0005.

## v0005 — 2026-07-23 (Priority 6)

Per-claim provenance across three origins (decision 0046). A new
`GENERAL KNOWLEDGE: allowed` input line (present only for knowledge-class
questions) permits blending: claims resting on provided facts keep their
`[F#]` markers (including web-sourced facts), and every statement from the
model's own knowledge ends with the new `[U]` marker — per statement, never
per paragraph; an unmarked claim-bearing sentence is defined as the model's
failure. The order of authority is frozen: the user's facts beat model
knowledge, contradictions are stated plainly with both origins marked, and
unsure means saying so with `[U]` rather than fabricating. Without the line,
`[U]` is forbidden and facts-only behavior is verbatim v0004. Adds `smalltalk`
mode (natural brief reply, no markers, honest capability description, RECENT
TURNS for tone) and lets the honest-gap path append marked general knowledge
when allowed. Everything else verbatim from v0004.

## v0004 — 2026-07-05 (F3-B)

The open-loops answer (decision 0013 ruling 7): `tasks` mode renders the OPEN
LOOPS block as a human rundown — actionable-now first (due dates), then
blocked ones with their condition in plain words ("waiting on Luka's budget
confirmation"), quiet ones nudged, unconfirmed ones softly framed, done and
dismissed never shown, every task covered and cited to its deriving fact.
Everything else verbatim from v0003.

## v0003 — 2026-07-05 (F3-A)

The temporal contract (decision 0012 ruling 6): fact blocks may carry a
`PAST BELIEF` marker (replaced/outdated or interval closed) — the answer must
never state them as current, frames them as "Until <boundary> you had X; since
then Y" with the successor when named, and treats them as history, never as a
dispute with their successor. Adds the three temporal-mode behaviors: previous
(lead with past belief, then the replacement), point_in_time (answer as of the
ASKED ABOUT date), change_since (narrate the CHANGES block with dates, no
padding). Everything else verbatim from v0002; citations unchanged.

## v0002 — 2026-07-03 (S3.5-B)

Quality-hardening from owner testing. (F2) explicit "describe the world, not the
retrieval" — the words facts/records/referenced/on-record are forbidden in
user-visible text. (F1/F4) a `MODE` block and per-fact subject entity: in
`entity_profile` mode the answer opens with who the subject is and aggregates ALL
their facts; a fact ABOUT Ana that MENTIONS Marta describes Ana, and a
mentioned person is never presented as the asked-about person. (F6) the strict
`[F#]` marker rule with two few-shot examples and an explicit ban on `[F2, F4]`
grouping. (hedge display) uncertain facts are included with soft framing and
never stated as confirmed. Honest-gap / nothing-on-record behavior unchanged.
Runs on the answer tier (decision 0007 ruling 3).

## v0001 — 2026-07-03

Initial release. Grounding rules (facts-only, no invention, honest gaps +
capture suggestion), mandatory inline markers, status and validity caveats in
prose, answer in the question's language.

## v0009 (issue #479)

The grounded answer learns WHAT THE QUESTION IS ABOUT. v0008 received the raw
question and the facts, so a follow-up using a pronoun made the model re-derive
its own referent by elimination over the fact block, and hedge when elimination
was ambiguous. Three new blocks, all context and none evidence: `RECENT TURNS`
(fenced, bounded), `THE QUESTION IS ABOUT` (the subject the pipeline already
resolved, deterministically), and `RESOLVED` (the question with its references
filled in, under the user own words). A new section states the rule the whole
change rests on: the conversation says what is asked, the facts say what is
true, and a claim that appears only in an earlier turn is not on record.
