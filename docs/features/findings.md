# Findings lifecycle: a contradiction has a life

**V2.3 item 6.1, issue E. The decision record, frozen before the code. Owned
by `memory` (the relation is the finding); migration 0048.**

A finding is a detected contradiction: one `memory_relation` row of kind
`contradicts`. Before this unit a finding had exactly two states, open and
resolved-by-the-owner, and a corrected corpus kept showing stale findings as
current because nothing connected a supersession to the finding it settled.
This record defines the full lifecycle, designed for the consumer that made it
necessary: the report's delta view (item 6.2), which must state what appeared,
what was resolved and by what, and what came back.

## The states

| State | Meaning | How it reads on the row |
|---|---|---|
| `open` | The conflict stands; both parties are presented as contradicted. | `resolved_at IS NULL` |
| `resolved by user` | The owner confirmed a side, corrected both, or dismissed. | `resolved_at` set, `resolution` in `confirmed_a`, `confirmed_b`, `corrected`, `dismissed` |
| `resolved by revision` | A supersession settled the conflict without a human. | `resolved_at` set, `resolution = 'revision'` |
| `reopened` | A later change reintroduced the conflict into the same finding. | `resolved_at IS NULL` again, with the history in the event log |

There is no separate `reopened` column: reopened IS open, with history. What
distinguishes a reopened finding from a fresh one is its event log, and that
is deliberate, because every surface that asks "what is current" must treat
the two identically, while only the report's delta view cares about the
difference.

## The event log

`memory_relation_event` records every transition, append-only, FK CASCADE
with the relation (the finding's history is exactly as durable as the finding):

- `detected`: written at creation, carrying the detecting pass
  (`pipeline`, `dreaming`, or `repair`) so "when and how did this appear" is
  answerable. The relation row also carries `detected_by` for cheap reads;
  `detected_at` already existed.
- `party_superseded`: a party was superseded but the conflict persists
  against the successor; the finding stays open and the relation now names the
  successor. Detail records the old and new memory ids.
- `resolved_by_user`: the owner resolved it; detail records the resolution.
- `resolved_by_revision`: a supersession settled it; detail records the
  superseded party, its successor, and, when the two sources are linked
  revisions, the `source_revision` id, so the report can say "resolved by
  revision 2.1 of the datasheet" and point at evidence.
- `kept_open`: a party was superseded and the successor still conflicts with
  the counterpart ambiguously, or no verdict was obtainable; detail records
  why the finding was not closed.
- `reopened`: the conflict came back; detail records which successor pair
  reintroduced it and which resolution it undoes.

Detail is structural metadata only: ids, sides, pass names. Never content;
the parties' own rows carry the words.

## Automatic resolution: conservative by construction

When reconciliation supersedes a fact that is a party to an open finding, the
finding does NOT resolve merely because a side changed. The successor is
judged against the counterpart through the same contradiction family, ledger
first:

- Verdict `compatible`: the conflict is genuinely gone. The finding resolves
  as `revision`, the surviving counterpart is restored to its recorded prior
  status, and the event names the cause, including the source revision link
  where one connects the two sources.
- Verdict `contradicts`: the conflict persists. The finding stays open and
  follows the successor (`party_superseded`): same finding, new party, no
  second finding for the same conflict.
- Verdict `supersedes` or no verdict obtainable: ambiguous. The finding stays
  open, and a `kept_open` event records why it was not closed. A findings
  report that clears items it should not is worse than one that clears too
  few.

A user-resolved finding is never automatically reopened or re-resolved by
this machinery except through reintroduction (below): the owner's judgment
outranks the engine's.

## Reopening

Before creating a new finding, detection walks both parties' supersession
chains. If a resolved finding exists whose parties are ancestors (or the
facts themselves) of the new pair, that finding reopens instead: parties are
updated to the current heads, `resolved_at` and `resolution` clear, and the
`reopened` event preserves what was undone. A corpus that regresses shows
that it regressed; it does not show a fresh discovery.

The canonical-pair tombstone rule is unchanged for open and resolved
findings alike: one finding per conflict, however many times it is
re-detected.

## Surfacing

Resolved findings disappear from everything presented as current: the Review
queue, the open counts, badges, the attention feed, and chat's contradicted
status. They remain queryable with their history on the source detail and
fact detail surfaces, labelled with their resolution, because the delta view
and the audit story both need them. Nothing anywhere presents a resolved
finding as live.

## What is deliberately out

- No model call decides a resolution on its own new evidence: only the
  existing contradiction judgment, applied to the successor pair.
- No batch backfill of pre-0048 findings' event logs: their `detected`
  events exist only from this migration on, and `detected_by` is NULL for
  history, which reads as "not recorded", never as a guess.
- Delta reporting itself is item 6.2; this unit records enough that the
  report is computed, never reconstructed.
