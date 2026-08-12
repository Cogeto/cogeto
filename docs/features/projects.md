# Projects: workspaces over one shared memory

**V2.5 item 8.3, spec §8.3. Owned by `projects`; migration 0056. Decision
record, frozen before the code.**

The public wording of this feature is fixed by the plan and must not drift:

> Projects organize your work and keep your files and context private; memory
> stays one connected mind.

A project is a **folder for the work**, not a compartment for the knowledge. It
groups the conversations you had about a client, the documents you uploaded for
them, the Confluence space you connected, the research you ran and the reports
you produced. It can **narrow retrieval** so a conversation about one client
answers from that client's documents. It does **not** decide what you are
allowed to see, and it does not split the corpus.

## The one rule everything else follows from

**Projects are organisation and filtering, never authorisation.**

A user's visibility of a fact is decided exactly as it is today, by three
things and no others: **ownership**, **scope** (`private` / `shared`) and
**sensitivity**. Those are the hard gates, they live inside the memory module's
queries and its Qdrant payload pre-filters, and this feature does not touch
them. Belonging to a project never grants access to anything, and never
withholds it either: every fact a project's lens filters out is still the
user's own fact, still returned everywhere else, still in one index, still in
one pool.

Concretely, and permanently:

- **No `project_id` column on `memory`.** Not now, not as an optimisation
  later. The moment a memory row carries a project, the project becomes a
  property of knowledge rather than of work, and the next reasonable-sounding
  change makes it a filter that a query cannot opt out of, which is a gate.
- **No third gate dimension.** `buildGateFilter` keeps exactly the two
  conditions it has. The lens is an **additive pre-filter on top of the
  gates**, the same shape reconciliation's candidate narrowing already uses
  (`scope`, `ownerOnly`, `statuses`), and it can only ever shrink a result
  that the gates already permitted.
- **No project field in the Qdrant payload.** The payload mirrors the memory
  row's gate and provenance fields; a project field there is the same mistake
  one layer down, and it would make an assignment change a vector-index write.
- **No per-project memory isolation.** The 2.0 audit priced that at 55 to 70
  files, a full reindex, two broken published contracts and an inversion of
  the continuity decision. It was rejected then and it stays rejected. Per-user
  private context is the existing scope model's job.

A future contributor reading a "projects" table will be tempted to move the
association onto memories, because the lens query would then be one equality
instead of a ref list. **That is the change this document exists to refuse.**
The ref list is not a limitation to be optimised away; it is the shape that
keeps the association on the container.

## What a project is

A lightweight, **per-user** record:

| Field | Meaning |
|---|---|
| `owner_id` | Whose project it is. Per-user, like conversations. |
| `name` | What the user calls it. Unique per owner, so two "Client A" folders cannot quietly diverge. |
| `description` | Optional, one paragraph. |
| `marker` | A colour token key for quick recognition in a list. A design-system token name, never a hex value. |
| `archived` | Leaves the active list, keeps everything. The safe action. |
| `lens_enabled` | Whether conversations in this project narrow retrieval by default. On by default. |
| `extraction_*` | The small per-project extraction policy, below. |

**Team-shared projects are an explicit non-goal for this version.** A project
belongs to one user, exactly like a conversation, and the API is Principal
gated with the owner id in the WHERE clause of every read. Sharing a project
would mean deciding what a shared project does to a `private` memory's scope
gate, and that question is exactly the one this feature refuses to open. It is
recorded here as a non-goal rather than half-built: there is no `org_id` on the
row, no membership table and no dead UI for it.

## What can be assigned

Five kinds, one table, one uniqueness rule:

| Kind | The thing | Why it is here |
|---|---|---|
| `source` | One ingested source (`source_type` + `source_id`) | The unit the retrieval lens and the report scope are built from. |
| `conversation` | One chat conversation | What makes the lens reachable: the lens applies to a conversation, so the conversation has to know its project. |
| `research_run` | One web-research run | The run's cited web sources land in the project automatically. |
| `connector_sub_scope` | One connector sub-scope (a Confluence space, a page subtree) | Everything the scope ingests lands in the project automatically. |
| `findings_report` | One generated report | So a client's reports live beside the client's documents. |

**Assignment is optional everywhere.** Unassigned work behaves exactly as it
does today; there is never a forced choice of project before doing anything,
and a user who ignores projects entirely sees no behavioural change anywhere.
Absence of an assignment is byte-identical to the pre-feature path, which is
tested rather than asserted.

**At most one project per thing.** The uniqueness is a database constraint on
`(ref_type, ref_id)`, not a convention. Multi-project membership was
considered and rejected: it makes "which project's lens applies to this
conversation" and "does this client's report contain this document" both
ambiguous, and every user-facing answer to the ambiguity is worse than the
restriction. If a case where multiple genuinely helps turns up, it is a change
to this record first.

### Assignment is a property of the container, never of a memory

A source assigned to a project keeps producing ordinary memories in the one
shared pool: same owner, same scope, same sensitivity, same index, same
retrieval. The project records **which sources it groups**, and nothing else.
Every derived thing follows the source, exactly as it does today.

The two **container** kinds propagate at the moment a source is created, not by
a join at read time:

- A **connector sub-scope** assigned to a project stamps a `source`
  assignment on every source it materializes, inside the upload transaction
  that creates the source. A Confluence space assigned to "Client A" therefore
  puts every page it syncs into Client A, including pages synced months later,
  with no repair pass and no back-fill query.
- A **research run** assigned to a project does the same for the `web` sources
  it captures.

Propagation happens once, at materialization, so an assignment change is never
retroactive by construction: moving a space to another project moves what it
ingests **next**, and what it already ingested stays where it was recorded.
That is stated in the interface, because the alternative (silently rewriting
history) is the surprising one.

## The retrieval lens

Within a conversation assigned to a project whose `lens_enabled` is on,
retrieval narrows to that project's sources.

### It is a filter, and it is built like one

The lens is a **bounded list of source refs**, resolved per turn from the
project's `source` assignments and handed to retrieval as a value. Retrieval
passes it to the memory module, which applies it:

- in the SQL arms (full-text, entity, subject, temporal, open loops) as an
  exact `(source_type, source_id) IN (…)` clause, ANDed with the gates and
  never in place of them;
- in the vector arm as a Qdrant `source_id` payload pre-filter, so the
  narrowing happens **inside** the vector query rather than after it, and the
  top-k the fusion sees is a top-k of the project;
- and again exactly, in Postgres, when the vector hits are resolved into rows.
  The Qdrant arm narrows on `source_id` alone (the payload carries no
  composite key); Postgres is the exact belt on the full pair. SQL first,
  Qdrant ranking within it, is the same order the temporal path already uses.

The list is capped (`LENS_SOURCE_CAP`, 2000). A project larger than the cap
still filters exactly in Postgres; only the Qdrant pre-filter is skipped, so
the vector arm over-fetches and the Postgres resolution drops what is out of
project. That degrades vector **recall** inside a very large project, never
correctness, and never a gate. It is stated here rather than hidden because
"the filter silently stopped applying" would be the worse failure.

The memory module reads the refs as a **value**. It never joins to a projects
table, because it does not own one, and the module boundary is what keeps the
association from creeping onto the memory row.

### What happens when the project cannot answer: the decision

There are two defensible behaviours and the plan requires picking one:

1. **Say the project holds nothing, and offer to widen.**
2. **Answer from the whole pool and state that the answer came from outside
   the project.**

**Cogeto does (1).** When the lens is on and the project's sources hold nothing
above the relevance floor, the answer says so, names the project, and offers a
one-tap "answer from all my memory". Nothing is silent: neither the narrowing
nor the gap.

Why (1) and not (2):

- **It is the rule this product already froze once.** Research is offered,
  never silently triggered: *the offer is the bridge; the gate stays the gate.*
  A lens that reaches outside itself whenever it is convenient is the same
  silent escalation, in the surface where the consequence is worst.
- **The failure mode of (2) is a cross-client answer under a banner.** A
  banner is read once and skimmed forever. Someone working in "Client A" who
  gets Client B's contract value with a caption has been handed the wrong
  number in a way that looks like an answer. Cogeto's whole claim is that you
  can tell what it can prove and where it came from; an answer whose relevance
  depends on the user reading a caption fails that claim.
- **(1) is not the "feels broken" failure the plan warns about.** The broken
  version is a bare "nothing on record" when the user knows the fact exists.
  This one names the project, states that memory outside it may hold the
  answer, and widens in one tap without leaving the conversation. The user is
  never stuck and never has to reorganise anything to get an answer.
- **There is one widening path, not two.** The per-question widen offered here
  is the same control as the lens toggle in the composer, so the affordance a
  user learns from the gap is the affordance they already had.

The reply reuses the existing not-from-your-sources vocabulary rather than
inventing new language, and it is a deterministic server-authored string in
the anchor language, like every other zero-answer reply.

A **knowledge-class** question is unaffected in shape: it still gets the
silent-corpus preamble followed by clearly marked `[U]` general knowledge. Only
the preamble's wording changes, to name the project instead of "your sources",
because claiming the whole corpus is silent when only a project was searched
would be a false statement.

### Visible and reversible

- The composer shows which project the conversation is in and that the lens is
  applied.
- **Widen for one question** is a per-turn flag on the send endpoint. It is not
  persisted as a preference and it does not move the conversation: the next
  question is lensed again. This is the same control the gap reply offers.
- Every stored assistant message records what the lens did
  (`chat_message.lens`: project id, applied, widened), so re-opening a
  conversation renders the same honest labels it showed live. The record holds
  identifiers and booleans only, never a name and never content.
- Turning the lens off for a project (`lens_enabled = false`) makes its
  conversations behave exactly like unassigned ones. Assignment without a lens
  is a perfectly reasonable way to use projects as pure organisation.

### Ambiguity fan-out inside a lens

The lens narrows the **candidate set**; the spec §7.5 decision rule is
unchanged, and no threshold moves. Clustering runs over the post-fusion
distribution exactly as before, so a fan-out inside a project fans only across
subjects the project holds, and a project that holds one of two same-named
subjects produces a dominant answer where the whole corpus would have fanned
out. That is the intended consequence: a smaller, more coherent candidate set
is what the relevance floor and the comparability ratio were calibrated to
reward. Both properties are asserted as tests rather than argued.

### Unassigned conversations

No lens, no extra query, no changed prompt, no changed answer. The lens
resolution is one keyed read that returns null and short-circuits.

## Projects as the scoping unit

### Connectors

A sub-scope's project is chosen on the connector's scope list. The sync engine
stamps the assignment on each materialized source inside the upload
transaction, so there is no window in which a page exists without its project
and no repair pass to run. Removing a connector releases its sub-scope
assignments; the **sources it already produced keep theirs**, because they are
still the client's documents.

### Findings reports

`ReportScopeDto` gains a `project` kind. The run enumerates exactly the
project's `source` assignments and nothing else, so a client-facing report
contains that client's documents **structurally**, not because the user
remembered to tick the right boxes. The scope is stated on the report itself,
as every scope is: the artifact names the project and lists what it examined.

This changes the published findings-report artifact, so it is a **schema
version bump to 1.1**, additive: the scope block gains `project_id` and
`project_name`, and its `kind` gains `project`. Version 1.0 stays published and
every 1.0 artifact keeps verifying, because the integrity block, the
canonicalization and the signing procedure are untouched.

### Sources

The catalog filters by project and every row and detail carries its project, so
"what is in this client's folder" and "which client does this document belong
to" are both one look.

### Per-project defaults, kept small

**A project is not a settings hierarchy.** Exactly two things are configurable,
and both exist because the alternative is repeated manual work:

1. **The retrieval lens**, on or off.
2. **An extraction policy applied to sources entering the project**: whether
   to extract at all, a fact budget, and a retention in days.

The extraction policy does not add a dimension to the extraction gate and does
not change how the gate decides. It reaches the pipeline through a port the
**ingestion** module defines and the **projects** module implements, and its
numbers fold into the same tightest-wins arithmetic every other bound already
uses (parse cap, registry budget, gate row, gate rule, project). A refusal
caused by a project's policy is recorded in the existing refusal ledger with
its own named reason, so a gated source never looks processed-with-zero-facts.
Nothing else about a project is configurable, and adding a third knob is a
change to this record first.

## Lifecycle

**Archiving is the default action.** It sets one boolean. Everything stays
assigned, the lens keeps working for conversations already in the project, and
nothing is deleted.

**Deleting a project never deletes its contents.** The project row goes, its
assignment rows go with it, and its conversations, sources, research runs,
reports and connector scopes all remain, unassigned. The confirmation says
exactly that, in those words, because a user deleting a client folder in most
software expects the opposite and the difference is the whole point. A user who
does want the contents gone reaches source deletion, through the existing saga,
with its receipts, separately and deliberately.

### Deletion coverage: the finding, stated

**Project records carry no source-derived content.** `name`, `description` and
`marker` are the user's own words and choices, typed into a form; they are
never extracted, never quoted, never derived from a document. `project_assignment`
carries identifiers and a kind, and nothing else: no filename, no title, no
excerpt. Nothing on either table would be a leak after a deletion receipt
promised the source was erased.

There is therefore nothing for the deletion saga to **erase** here, but there
is something for it to **release**: an assignment pointing at a source that no
longer exists is stale state. `ProjectAssignmentCascade` deletes those rows
inside the saga's enumeration transaction and reports the count on the receipt
(`project_assignments_released`), the same shape every other derived cascade
uses. Deleting a source therefore takes it out of its project as part of the
same signed act, and the nightly sweep has nothing new to look for.

The reverse direction is the one that matters and is asserted as a test:
**deleting a project runs no saga, mints no receipt, and erases no memory,
because it destroys nothing that was ever derived from a source.**

## What enforces what

| Property | Enforced by |
|---|---|
| No project column on `memory`, no project in the vector payload | `projects-are-not-a-gate.spec.ts` (structural: the memory table's columns and `memoryPointFor`'s payload keys) |
| The lens can only shrink a gated result | Same spec: the lens filter is applied beside `buildGateFilter`, never inside it, and a lensed search over a foreign owner's shared facts returns exactly what the unlensed gate returns, intersected |
| At most one project per thing | `project_assignment` unique index on `(ref_type, ref_id)` |
| Unassigned behaviour is unchanged | `projects-inert.integration.spec.ts`: the same question, same corpus, no project anywhere, byte-identical answer path |
| Deleting a project leaves its contents intact and unassigned | `projects-lifecycle.integration.spec.ts` |
| A project-scoped report contains only that project's sources | `report-project-scope.integration.spec.ts` |
| Table, job-type, token ownership | `entrypoints/boundary-contract.spec.ts` |
