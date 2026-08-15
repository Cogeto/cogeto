# CLAUDE.md: how to work in this repo

Cogeto turns document sets into **verified, provable institutional memory**: it
reads documents including scans, verifies every fact against its own source sentence
before storing it, reports contradictions between documents, and produces a signed
findings report a third party can verify. Every trust claim is backed by an
inspectable artifact. EU hosted, self hosted, or fully offline.

**The binding engineering rules live in [`AGENTS.md`](AGENTS.md). Read them first.**

## Doc map

| Doc | Read it when |
|---|---|
| [`docs/cogeto-specification.md`](docs/cogeto-specification.md) | **The normative rules.** MUST is a rule whose violation is a defect. Wins over every other doc. Cited as spec §N. |
| [`docs/cogeto-v2-plan.md`](docs/cogeto-v2-plan.md) | **Before any 2.0 work. BINDING.** The complete 2.0 plan, version by version, with priority and difficulty. |
| [`docs/cogeto-technical-architecture.md`](docs/cogeto-technical-architecture.md) | How it is built: deployment, module structure, the pipeline, access gates, the model gateway, trust machinery. |
| [`docs/module-boundary-contract.md`](docs/module-boundary-contract.md) | **Before adding a table, a job type, a DI token, or a module, and before making one global. BINDING.** Which module owns what, the global-module policy, what enforces each rule, and every recorded exception with the part that closes it. |
| [`docs/cogeto-verified-memory.md`](docs/cogeto-verified-memory.md) | What is stored, what is guaranteed, and how each guarantee is enforced. |
| [`docs/features/`](docs/features/) | How a feature actually behaves and why. Start here before changing one. |
| [`docs/features/projects.md`](docs/features/projects.md) | **Before touching the retrieval lens or anything named project. BINDING.** Why projects never gate memory, what may be assigned, and the lens fallback decision. |
| [`docs/features/i18n.md`](docs/features/i18n.md) | **Before touching any user-visible string.** Where the locale files are, how a language is resolved, the CI key-sync guard, and the translator workflow. |
| [`docs/security/`](docs/security/) | **Single entry point for security and safety**: how the protections work, how to verify them, and the co-located tests. |
| [`docs/engineering-workflow.md`](docs/engineering-workflow.md) | **Before opening any issue, branch, or PR.** The delivery loop, Conventional Commits, required checks, tag-driven releases. |
| [`docs/glossary.md`](docs/glossary.md) | The ubiquitous language. Names in code must match it. |
| [`docs/eval-golden-set.md`](docs/eval-golden-set.md) | Corpus format, metrics, CI gates, and the two corpora. Read before touching the extractor, a prompt, or the harness. |
| [`project/eval/vertical/README.md`](project/eval/vertical/README.md) + [`docs/eval/vertical-corpus-diagnostic.md`](docs/eval/vertical-corpus-diagnostic.md) | **The document corpus and what real documents did to the pipeline.** Read before changing ingestion, anchoring, the reader seam or the quantity parser. |
| [`docs/research/*.md`](docs/research/) | **Required before implementing the matching area.** See the table in `docs/research/README.md`. |
| [`docs/cogeto-scope.md`](docs/cogeto-scope.md) | What Cogeto is, who it is for, what is in and out of scope, licensing. |
| [`docs/operator-runbook.md`](docs/operator-runbook.md) + [`docs/operations/`](docs/operations/) | Running a customer instance. |
| `project/README.md` + per-directory READMEs | Orientation: what lives there, allowed dependencies, the specification rules that govern it. |

## Repo shape

- `project/src/`: modular monolith: one directory per bounded context, two
  entrypoints (app, worker). Module rules: `project/src/README.md` (spec §15).
- `project/web/`, chat + dashboard frontend. `project/prompts/`, versioned prompt
  artifacts (spec §12.3). `project/infra/`, compose stack; `docker compose up` is the
  contract. `project/eval/`, golden set and chat cases.
- `docs/`: architecture, features, security, operations, research.
- Application tests live under `project/src/`, next to the code they exercise (Vitest).
- `assets/brand/`: canonical logo files (trademarked, not AGPL: see TRADEMARK.md).
  Reuse from here; never generate, recreate, or modify the logo.

## Current state

v1.6.0 is the current release line. The task subsystem and reminders were **removed**
in V2.0 items 3.1 and 3.2: Cogeto has no tasks, no to-dos, and no reminders. What
survives is **open loops**, `commitment` and `open_loop` memories read straight from
the memory table, due-dated by `valid_until`, surfaced in chat and on the attention
feed.

V2.0 item 3.3 removed the last manual queue over facts: **Cogeto resolves its own
reviews.** Unsupported, partial, hedged and unjudgeable extractions are admitted
automatically as `uncertain` with a named sub-reason on `memory.uncertainty_reason`,
and every automatic demotion or non-admission is recorded in the content-bearing
`suppressed_fact_log` (which is therefore in the deletion cascade). The Review page
shows **contradictions only**; confirming a fact is a contextual action on the memory
drawer. There is no approval queue for facts anywhere.

V2.0 item 3.4 made the published numbers complete. The trust artifact (schema
**1.1**, additive) now carries **contradiction precision**, **supersedes accuracy**
with its denominator, and **query-rewrite routing accuracy**, per language and
aggregate; gates have a **per-language layer** so no language hides in an aggregate,
and a language `project/eval/gates.json` does not name fails the check. Every floor
is justified in [`docs/eval/gate-model.md`](docs/eval/gate-model.md), the governing
rule being: publish everything measured, gate at the honest current value, ratchet up
only, never gate at a target the project is below. Pull requests now run the **golden-set
suite against committed cached fixtures** (`project/eval/cache/`); change a prompt
and the cache misses by construction, so run `npm run eval:cache:refresh` and commit
the fixtures in the same change. A cached run can never publish a trust score. The
chat suite is deliberately not cached (retrieval returns equally scored facts in a
different order every run, so the answer prompt is not reproducible) and still runs
live post-merge.

The 2.0 security audit ([`docs/audits/`](docs/audits/)) is closed out across five
remediation waves: every finding is fixed or consciously accepted with a written
rationale, and the audit and its independent verification are both published there.
Two operator-visible consequences worth knowing before changing anything nearby:
inbound email is now behind the `mail` compose profile and is **off by default**, and
the five deployment assets are checksum-verified by the installer, so editing one
means regenerating `project/infra/deploy/deploy-assets.sha256` in the same change.

The **deployment-readiness audit** ([`docs/audits/deployment-readiness.md`](docs/audits/deployment-readiness.md))
is closed out across five waves of its own; only the two owner-scoped copy
findings remain. Three consequences bind new work. **Every service in both
compose files drops all capabilities and sets `no-new-privileges`**, and eleven
of them, including the app and the worker, run on a **read-only root** with a
tmpfs `/tmp`: a service that needs a capability or a writable path must state
which and why in the file, and `deployment-hardening.spec.ts` pins the exact
grant list. Practically, this means you cannot write a scratch script into
`/repo` inside a running container: use `/tmp`, or
`docker compose exec -T app node < script.js`. Second, an **active compose
profile whose required secret is empty is refused at boot** (the preflight and
the service's own healthcheck), so a hand-edited `COMPOSE_PROFILES` fails loudly
instead of running unsigned. Third, the operator script is exercised in CI by
`scripts/ci/operator-smoke.sh` against a real stack: **anything it prints must
be performable and anything it reports must be observed**, and the test fails on
a printed instruction naming a retired mechanism.

V2.0 item 3.5 made the product translatable. Every user-visible string in the
SPA is a key in `project/web/src/locales/<locale>/<namespace>.json` (one
namespace per surface; the current list is `namespaces.ts`), the copy Cogeto writes on its own lives in
`project/src/infrastructure/locales/`, and **English is the source of truth and
the fallback for every missing key**. `npm run i18n:check` runs inside `lint`
and fails the build on a missing, orphaned or unused key, a missing plural
category, a dropped `{{placeholder}}`, an em dash in English copy, or a
reintroduced hardcoded literal. Add a language with
`npm run i18n:add -- <locale>`; add a KEY to an existing feature with
`npm run i18n:sync`, which backfills the other locales from `en` without ever
overwriting a translation. **The rules that bind every change touching
user-visible copy are in [`AGENTS.md`](AGENTS.md) under "User-visible copy", and
a feature is not done until its keys exist in every locale.** Interface language
is not extraction quality: only English and Croatian have corpora and gates, and
nothing in the product may imply otherwise.

The deployment-readiness pair F13 and F14 closed that item out (2026-08-15).
`hr`, `de` and `fr` are no longer scaffolds but **complete translations**, and
the guard makes that keepable: a value identical to its English source fails
the build unless it is one of 112 listed as identical BY DESIGN, and an
allowlist entry that excuses nothing fails too. Terminology is fixed in a
per-locale glossary in [`docs/features/i18n.md`](docs/features/i18n.md).
Separately, **a server failure a person reads is now a CODE, not a sentence**:
every HTTP failure is built by `infrastructure/api-error.ts` through
`userError` (coded, translated by the interface) or `untranslatedError`
(declared untranslatable: a developer error, a machine client, or text we did
not write), constructing a Nest exception anywhere else fails `lint`, and the
`serverErrors` namespace is held to the throw sites in three directions. The
interface renders no raw server text where it holds a translation. Every guard
category is proved by breaking it in `entrypoints/i18n-guard.spec.ts`.

V2.0 item 3.6 made the module boundary real and then moved the code behind it, in
four pull requests. **Read [`docs/module-boundary-contract.md`](docs/module-boundary-contract.md)
before adding a table, a job type, a DI token or a module.** A boundary here is
**imports plus table ownership plus job-type contracts plus DI visibility**, and all
four are machine-checked: `boundaries` covers imports and forbids a barrel from
re-exporting a live table, and `entrypoints/boundary-contract.spec.ts` (inside `test`)
verifies the owner of every table, job type and token plus the global-module
allowlist. What changed underneath: `connectors/` dissolved into six family modules
(`notes`, `files`, `email`, `research`, `skills`, `settings`); **chat left retrieval**
for its own context and `chat.service.ts` became an orchestrator with explicit intent
handlers; `entrypoints/` gave up its seven controllers and two services and now holds
composition roots, root wiring and CLIs only, with `attention` and `operations` as
new declared contexts; **`source_type` is a registry, not a Postgres enum** (migration
0040), so a new source type is a declaration plus its ports, never a migration; and
**no domain module is global**: each root builds one dynamic instance and threads it
through every consumer's registration options.

V2.0 item 3.7 closed the correctness and hygiene debts the audit itemized, most of
which the five security waves had already absorbed. What is new: **file downloads and
model-gateway egress are audit-logged** (a presigned URL and a call to a rented model
are both moments something leaves the box), every audit writer with an owner now
stamps an org, `GET /api/receipts/verify` no longer hands an ordinary caller the
instance-wide counts, the **unscoped `MemoryStore` reads live in a `MemorySystemStore`
the app composition root does not provide** (so an ungated corpus read is
unrepresentable in the process that serves requests), and **chat capture stamps the
owner's default scope** instead of falling to the pipeline's `private` fallback like
no other connector. Consolidation was deliberately narrow and mechanical: one
Zod-to-400 adapter (`parseOrBadRequest`), one research citation-marker grammar in
`@cogeto/shared`, one scope-and-sensitive gate expression
(`memory/domain/scope-gate.ts`) serving both gated tables, and 230-odd unused barrel
exports removed.

V2.1 item 4.1 delivered its **native-format half**: Cogeto reads **XLSX and CSV**,
and a format is now a **registered reader** (`project/src/files/reading/`) rather than
a branch in a switch. Selection is by **magic bytes with the declared type and the
extension as hints**, so a mislabelled upload is routed by what it is or refused;
DOCX and XLSX are both ZIP, so the sniff inspects the package entries. PDF and DOCX
moved behind the seam **byte-identically**, proved against the pre-seam code copied
into the spec. A reader emits text plus a **structured locator** per segment (page,
paragraph, or sheet + row + A1 cell range + columns) that nothing downstream consumes
yet, because V2.2 and V2.3 render it; the pipeline contract is unchanged. Spreadsheets
become **statements, not grids**: column context on every row, headers found under
title blocks, merged cells resolved, formulas contributing their computed value and
never their text. Row caps are per sheet and per file, and a truncated read **says so**
on the source (`file_read_report`, migration 0041, owned by `files`, in the deletion
cascade) instead of quietly looking whole. That row also separates
**`unsupported_format` from `read_failed`** and labels an unreadable file `empty` /
`no_text`, which is the hook the OCR and vision half replaces with recovered text.
The OCR and vision half followed: a page that is a picture is read by a
**deterministic, cheapest-first ladder** (usable text layer, then local
Tesseract with en/hr/de data, then a vision model), and a page that cannot be
read says so instead of arriving as done-with-zero-facts. **Vision is a PROBED
capability**: the probe sends a real image, because a GGUF model is multimodal
only when its multimodal projector is loaded and nothing in its name says which
way it was served. Redaction and vision are mutually exclusive and fail closed.
The tier is recorded on the provenance locator; caps bound image work by
construction; `needs_vision` is a state about the INSTANCE, so a source can be
**reprocessed** once the capability arrives, and reprocessing reconciles rather
than duplicating. The vision path is deliberately NOT gated in CI, because
gating it would need a vision model in CI.

**Before changing anything in the reading path, read
[`docs/features/reading.md`](docs/features/reading.md).**

V2.1 item 4.3 delivered the **per-source extraction gate** (spec 1.6, migration
0042): extraction is admission controlled per owner and source kind, at one
deterministic chokepoint in the pipeline before any model call. Enable/disable,
fact budgets (tightest of parse cap, registry budget, gate budget), retention
(stamps `valid_until` only on facts without their own validity; the dreaming
staleness pass handles the lapse), and allow/deny rules (`document_class` =
the reading layer's detected format; `source_id` deny-only; `channel`/`folder`
reserved for connectors and bulk import). Refusals are a metadata-only ledger
(`extraction_gate_refusal`, 30-day prune, in the deletion cascade) so a gated
source never looks processed-with-zero-facts, and an absent gate row is
byte-identical to prior behaviour. The Settings page has the surface; the
tables and the API are `ingestion`'s. Spec 1.7 (injection defence for observed
content) was found already satisfied by the SEC-4 fence and guards, so no
prompt changed and the eval cache is untouched:
[`docs/features/extraction-gate.md`](docs/features/extraction-gate.md).

V2.1 item 4.2 delivered **source-context anchoring** (spec 1.5, migration
0043): one cheap anchor call over a document's opening and filename produces
its subjects, class and revision (each confident or uncertain), stored on the
ingestion-owned `source_context` row (content-bearing, in the deletion
cascade), editable on the source drawer, and injected into every chunk's
extraction call as a FENCED `DOCUMENT CONTEXT` block under `extraction/v0005`.
A fact's own text outranks the section heading, which outranks the document
default; empty or failed context renders a byte-identical pre-anchoring input.
Re-anchoring after an edit is the reprocess action, superseding via reconcile.
The plan-named golden cases gate it and the eval fixtures were refreshed
Mistral-routed: [`docs/features/anchoring.md`](docs/features/anchoring.md).

V2.2 item 5.1 made **chat the conversational door and Sources the deliberate
one**. Files attach in chat via a paperclip whose endpoint delegates to the
files module's upload (one path, two affordances): a durable attachment is an
ordinary file source, linked to its conversation by the chat-owned
`chat_attachment` row (migration 0045), whose card shows honest pipeline
stages from the new ingestion-owned `ingestion_progress` row and, on settle,
the stamped real numbers (facts, contradictions, gate refusal, read outcome)
plus a link into Sources. The **"don't remember this file"** toggle keeps an
attachment transient: bytes staged at the discard staging twin, read once by
the chat-owned `chat.attachment_read` job through the same reading ladder,
deleted commit-then-delete with a backstop; the text lives on the row for that
conversation only, enters the answer path as a fenced `ATTACHED FILES` block
(`answer/v0008`, attribution in words, never `[F#]` or `[U]`), and is erased
with the conversation under its receipt (`chat_attachments_removed`). The
Memories tab lost its note field and upload control (a dismissible pointer
says where capture lives; notes are captured only via chat's "remember
this"); the single-file upload moved to the new **Sources** page, where the
5.2 redesign and 5.3 bulk import will land. Every prior entry path survives,
including `POST /api/notes` and `POST /api/files` unchanged.

V2.2 item 5.2 delivered the **three-level Sources surface**: a new `sources/`
composition context (no tables, the attention/operations shape) serves
`GET /api/source-catalog` (one row per source with badge conditions as the
scan layer, cursor-paged and grouped-count cheap) and its per-source
inspection (facts joined to verification evidence, the suppressed log,
contradictions with resolution state, anchoring context, gate refusal).
**Span locators persist at admission** since migration 0046
(`verification_result.span_locators`, `suppressed_fact_log.span_locators`,
located via the shared `locateSpan`, which moved to `@cogeto/shared`), so a
fact's page/paragraph/cell position survives discard mode; older facts read
"no location recorded". Fact detail (the memory drawer) gained the hedge
phrase, located spans, a relations panel and **cited-by answers** (a scan of
the stored `{{cite:<id>}}` tokens, no new table). The flat memories list is
now the **filtered fact search** on /memories (plus a changed-since mode over
the change feed's new route); the nav rail shows Sources, and every legacy
deep link still resolves.

V2.2 item 5.3 delivered **bulk import and document revision linking**
(migration 0047). A new `imports/` module owns the first-class import record
(`import_run` + `import_item`): manifest FIRST from a folder, a dependency-free
ZIP walk, or an S3-style listing whose credentials are used and never stored;
content-hash duplicates and same-name revision candidates stay distinct;
nothing ingests until confirmed. A worker-side coordinator (plain re-runnable
`import.advance` under a per-run single-flight lock) feeds every document
through the ONE existing upload path at demoted queue priority 100 with an
in-flight cap of 1 (`COGETO_IMPORT_IN_FLIGHT`), so an import cannot starve
interactive work; the extraction gate and daily caps apply unchanged, and a
cap-exhausted import pauses visibly instead of bypassing. Resume is
rows-only, failures are per-file with named reasons, cancellation reports
honest counts, and erasing an ingested source TOMBSTONES its item (name
cleared, arithmetic kept). Revision linking follows the frozen decision
record [`docs/features/revisions.md`](docs/features/revisions.md):
anchored-revision corroboration links auto/high, subject+class+shingle
similarity proposes at medium, below the bar NOTHING is recorded, a rejected
pair is never re-proposed, a manual link overrides, all audited on the
ingestion-owned `source_revision` table; facts get nothing new (existing
reconciliation only). The completion summary's numbers are computed from the
owning stores and each click lands on evidence in Sources.

V2.3 item 6.1 delivered the **contradiction coverage overhaul and the findings
lifecycle** (migration 0048, prompt `reconcile_contradiction/v0002`, reconcile
config v2). Entity pairing is folding plus a growable `entity_alias` set (the
cross-language mechanism, Settings surface) plus a narrow mid-token typo rule,
with an alias-expanded subject search as a third candidate path; `related`
dedup verdicts escalate beside `distinct`, and `contradicted` rows are
candidates so a corrected revision can supersede a finding's party. **Numeric
and unit reasoning is deterministic first** (`ingestion/domain/quantity.ts`):
a same-slot conflict such as 3.2 mm vs 3.4 mm needs no model call, and
everything the parser cannot decide reaches the judge with parsed values. The
**checked-pair ledger** (`checked_pair`) persists every verdict with its
prompt version and model configuration: an unchanged pair is never re-judged,
so the nightly flip-flop and its token cost are structurally gone. Thresholds
are per-embedding-model and fail loudly on an unknown model; the supersession
guard tie-breaks equal event times on recording order; losers close at event
time. Timing misses are covered by the delayed `reconcile.repair` job and the
confirm-time eligibility re-pair; findings record `detected_by`. **A finding
has a lifecycle** ([`docs/features/findings.md`](docs/features/findings.md),
frozen before code; `memory_relation_event`): resolved by user or by revision
(conservative, cause recorded, `source_revision` link included), kept open
with the reason when ambiguous, following the successor when the conflict
persists, and reopening the ORIGINAL finding when a regression reintroduces
it. Resolved findings leave every current surface and stay queryable with
history.

V2.3 item 6.2 delivered the **findings report generator** (migration 0049, the
new `reports/` module): a signed, printable artifact from a findings run over a
stated scope (corpus, import, source set, date range), generated in the worker
with visible progress through the owners' gated reads only. One payload feeds
both formats: the **JSON is the signed record** (receipt-convention ed25519
over the canonical payload hash; schema published at
`docs/findings-report-schema/` with a fictional sample, drift-guarded in CI,
verifiable end to end with jq + openssl), the **PDF a deterministic,
dependency-free rendering** (hand-rolled writer over `node:zlib`, vendored
DejaVu faces in `project/fonts/` with a ToUnicode map so quoted evidence
survives copy/paste, the brand logo drawn as vectors from the provided file).
Coverage and limits precede the findings; trust scores are matched by exact
configuration id from the bundled `eval/trust-scores` artifacts and their
absence is stated, never borrowed; findings group by subject entity with both
verbatim spans located per the reader seam, OCR/vision recovery flagged, and
the 6.1 event log driving the delta view (resolved by which revision, newly
appeared, reopened; a first run says so). Deletion coverage repeats the
passport pattern exactly: `findings_reports_expired` on the receipt, both
object keys erased and swept, downloads refused with the reason, the SEC-8
mid-assembly race guarded; lifecycle audited (requested, ready, downloaded,
expired); artifacts retained 24 hours, run rows permanent. Details:
[`docs/features/report.md`](docs/features/report.md).

V2.3 item 6.3 delivered **ambiguity detection and fan-out answers** (spec
§7.5, migration 0050). The decision is **deterministic and adds no model
call**: a pure function (`retrieval/ambiguity.ts`) over the post-fusion
distribution across anchored-subject clusters (alias-canonical folded keys,
so 6.1's `entity_alias` set prevents one subject fanning out under two
names). Relevance is the best member **vector similarity**, carried through
fusion for the first time because a rank-derived RRF score cannot carry an
absolute floor; comparability is the ratio of max member fused scores, which
in practice measures signal consensus. Order: a query-named subject wins
(also how a fan-out's follow-up resolves), then the relevance floor, then
comparability. Thresholds are per embedding model in
`retrieval/ambiguity-config.ts` (ambiguity config v1, fail-loud on unknown
models, calibrated live on `mistral-default`: floor 0.90, ratio 0.55). The
three behaviours: **dominant** answers byte-identically to before;
**silent** states the sources hold nothing (knowledge-class gets a localized
preamble then marked `[U]` general knowledge with sub-floor facts withheld;
personal keeps `nothingOnRecord`); **fan_out** is a fully server-authored
answer, one line per subject with the best fact verbatim, its real
`{{cite}}` chip and a verdict word for non-active facts, capped at 4 with an
honest "N more", ending with "which did you mean?". `answer/v0008` is
unchanged and the eval cache untouched. Every grounded answer stores its
decision on `chat_message.ambiguity` (content-bearing, cleared by the answer
redaction cascade); the chat harness asserts branches as deterministic rule
checks and prints the suite-wide fan-out rate. Details:
[`docs/features/ambiguity.md`](docs/features/ambiguity.md).

V2.3 item 6.4 delivered the **second wave of eval gates**, anchored on a
**vertical corpus of real public documents** (gates v3, trust-score schema
**1.2**). **No application behaviour changed**: the diff is evaluation, corpus,
configuration and documentation only. 44 labelled cases (20 extraction, 24
reconciliation pairs) over 13 real documents, each recorded in
`project/eval/vertical/documents.json` with its URL, publisher, licence,
retrieval date and SHA-256; the bytes are fetched by `fetch.mjs`, never
committed, and the committed excerpts are verbatim reader output that must not
be edited (the two datasheets are CC BY-ND). The labelling rules were written
**before** the first label
([`LABELLING.md`](project/eval/vertical/LABELLING.md)) and every case is
traceable to its document, page range and reasoning. The corpus is **reported
and gated as its own set, never averaged** into the core numbers: a `vertical`
block in `gates.json` with the same two layers and the same union rule (its
third set, `xl`, is the cross-language pairs), both zero-tolerance gates counted
separately, and schema 1.2's `corpora` array carrying both corpora side by side.
**The document numbers are lower and are published anyway**: recall is strong,
precision is not (real documents hand back page furniture and registry
metadata), and the reconciliation arm is weakest of all, with supersession
across document revisions and cross-language contradiction detection both
scoring zero on this corpus. Authority-ranking cases are authored and **PENDING**
outside the loaded directory, because gating unshipped behaviour is exactly what
the governing rule forbids. **The first ingestion of the corpus is a deliverable
of its own** and is written up in
[`docs/eval/vertical-corpus-diagnostic.md`](docs/eval/vertical-corpus-diagnostic.md);
read it before touching ingestion, anchoring or the quantity parser.

V2.4 item 7.1 delivered its **configuration half**: model and provider
configuration moved out of the environment into the database (migration 0052,
the new `providers` module, six tables). A provider is a **record** an admin
manages, with a label they choose (several of one type are ordinary, so the
label is the identity), a type (Mistral, OpenAI, Anthropic, **Self-hosted** =
any OpenAI-compatible endpoint), an endpoint where the type needs one, and a key
**encrypted at rest** under `COGETO_MASTER_KEY`, which stays in the environment
because a key that guards a database cannot live inside it. **A saved key never
comes back out**: the sealed column is selected in exactly one function and
`key-confinement.spec.ts` asserts it structurally. Four independent assignments;
vision may be unassigned. **Discovery offers and manual entry always works**
(a proxied deployment legitimately serves models its `/models` route hides);
**validation probes the tier's real job**, never a model name. The configuration
id derivation is untouched, every change is recorded, and the page shows the
published trust score for the exact configuration in force or says **"not
evaluated"**. The **answer** tier is user-switchable among admin-enabled options
(an opaque option id, so call sites still name a tier); pipeline, embeddings and
vision stay admin-only. Changes apply **without a restart**: one live
configuration object per process, mutated in place, with the worker polling a
version column. **The interface is the only place models are configured**
(deployment-readiness remediation, 2026-08): the one-time environment seed and
the legacy environment expansion are DELETED, both composes carry no model
variables, the operator script knows nothing about models, and a stale model
variable in `.env` has no effect whatsoever (machine-checked by
`model-config-env.spec.ts`). The eval harness alone still resolves from the
environment, confined to its entrypoints, because it runs in CI against no
instance database. An instance with no provider configured is a NORMAL state:
it boots, serves, health stays ok with a distinct not-configured wording, the
shell shows a first-run banner pointing at Providers, and queued pipeline work
waits under a job key and drains without a restart once a provider is added.
Read
[`docs/features/models.md`](docs/features/models.md) and
[`docs/operations/upgrade-notes.md`](docs/operations/upgrade-notes.md) before
touching anything in the model-configuration path.

The **managed reindex** completed item 7.1 (migration 0053): changing the
embeddings model is a safe in-application operation, and **no interface action
can render the instance unstartable**. The vector index has durable state
(`embedding_index_state`, memory-owned: active collection, active dimension,
the rebuild in flight). The interface runs plan-then-confirm: a real probed
embedding yields the model's TRUE dimension, and the plan states facts, the
chars/4 token estimate the meter actually charges, a probed duration, the
spend, and that search keeps serving from the old index. The rebuild is the
`memory.reindex_advance` job (the `import.advance` shape), re-embedding from
Postgres into a NEW collection with resume-by-presence, metered attributed
spend, budget exhaustion pausing not bypassing, cancel always available. The
**switch is one transaction** under an embedding-write lock shared by every
stamped-vector writer: catch-up, gate-payload resync, orphan sweep, count
verification, row stamp, assignment flip via a port bound in the worker root,
state flip; a crash rolls it all back. Gate parity in the new collection is
tested, not assumed; payload writes and deletions dual-apply mid-rebuild; the
nightly sweep drops stray rebuild collections; the retired collection drops on
a grace period so stale pollers stay coherent. The boot guard stays as a net
with an actionable message naming **`cogeto reindex`**, the operator
subcommand sharing the same engine (flagless in-place repair, or
`--provider LABEL --model M` for an offline managed switch via `compose run`,
which works while the services crash-loop).

V2.5 item 8.1 delivered the **connector platform** (migration 0054, the new
`connectors` module): the foundation every external connector inherits, with
**no external service integrated**, because a platform shaped around one
vendor's quirks is not a platform. The decision record, frozen before code,
is [`docs/features/connectors.md`](docs/features/connectors.md); a new
connector follows
[`docs/features/connector-authoring.md`](docs/features/connector-authoring.md).
A connector is a registered **descriptor** (source type, auth style,
discovery and fetch, container-independent natural key, sub-scope model,
authored-or-observed authorship) and inherits: the eight-state lifecycle
(removal destroys credentials and sync state but **sources remain with
provenance intact**); credential storage inside the **identity seam**
(`connector_credential`, sealed under `COGETO_MASTER_KEY` by the secret-box
that moved to `infrastructure` so provider keys and credentials share ONE
mechanism, with the decrypting opener resolvable **only in the worker root**);
per-sub-scope cursors persisted after every page; the **natural-key ledger**
(`connector_item`, unique on connector + natural key, identifiers and
arithmetic only, never content) with content-hash skip, so an unchanged item
costs zero model calls and an upstream edit becomes a `source_revision` that
supersedes; bounded backfill (30 days / 500 items per sub-scope by default,
"everything" only as an explicit choice); the hostile-facing **webhook
ingress** (raw-byte HMAC before parse, replay tolerance, delivery dedup by
event id, enqueue-then-200, payloads as signals whose items are re-fetched
through the outbound path so webhook content never reaches a model);
**outbound rate limiting** (durable token bucket per connector, Retry-After
walls that reschedule instead of retrying into them); admission defaults per
authorship class (observed 200, authored 1000 items per connector per day,
configurable per connector and sub-scope, pausing visibly); and a
`connectors` capability entry. The `connector_maintenance` recurring job is
the refresh loop, the subscription renewer, and the polling fallback in one.
The platform is proved by a **reference connector that exists only in tests**
(`connectors/testing/reference-connector.ts`), whose harness every future
connector validates against; the named tests are the expensive failures:
interrupted-and-resumed re-extracts nothing, unchanged re-sync costs zero
model calls. Notes, files, chat, email and web research were deliberately NOT
migrated onto the platform (none is a pull-or-webhook connector; the reasons
are in the decision record) and are byte-identical.

V2.5 item 8.2 delivered the **first external connector: Confluence Cloud**
(migration 0055, the new `confluence` module), built entirely on the 8.1
platform and **strictly read-only by construction**: the client has one
request helper hard-coding GET, `read-only.spec.ts` fails the build if a
mutating verb or a second HTTP call site appears, and the security note
([`docs/security/confluence-connector.md`](docs/security/confluence-connector.md))
states honestly that an Atlassian API token carries its account's full
permissions and recommends a dedicated read-only account. **A re-sync over
unchanged content costs zero model calls AND zero body fetches**: change
detection is the page version number from a body-less listing, and content
became LAZY platform-wide (resolved only when the ledger decided to
materialize). Spaces are sub-scopes; page subtrees are custom scopes; the
backfill estimate is a worker job writing sub-scope stats; per-space policy
activated the gate's reserved `folder` dimension (sub-scope key stamped on
the object, carried by the file reader) with per-rule fact budgets and
retention. Storage-format XHTML converts to structured text (tables one
statement per row with column context, macros render inner content or drop
cleanly, nothing fabricated) read by the new registered plain-text reader
(`text/markdown`, paragraph locators). Provenance is the content-bearing
`confluence_page` row (page, space, version, live URL, in the deletion
cascade), surfaced on Sources and the drawer; an upstream edit supersedes
via the automatic revision link carrying the Confluence version, and the
findings lifecycle names it. The new **presence sweep** (descriptor
`listKeys` + `connector.presence_sweep`) marks deleted, archived and
permission-lost pages, never deleting; a partial listing never marks. The
platform additions are recorded in
[`docs/features/connectors.md`](docs/features/connectors.md); the decision
record is [`docs/features/confluence.md`](docs/features/confluence.md).

V2.5 item 8.3 delivered **projects as workspaces** (migration 0056, the new
`projects` module), under one overriding constraint: **memory gating is
untouched.** Projects are organisation and filtering, never authorisation, and
that is machine-checked, not asserted: there is **no project column on
`memory`**, no project field in the Qdrant payload, and `buildGateFilter` still
carries exactly its two conditions (`projects-are-not-a-gate.spec.ts`). A
project is a per-user record (team-shared projects are a **recorded non-goal**)
grouping five kinds of CONTAINER through one `project_assignment` table whose
unique index on `(ref_type, ref_id)` IS the "at most one project per thing"
rule; a connector sub-scope or a research run stamps its project on each source
it materializes, inside the same transaction that creates the source. The
**retrieval lens** is a bounded list of source refs, resolved per turn by chat
and handed to retrieval as a VALUE: an additive pre-filter on top of the
unchanged gates in every SQL arm and inside the vector query, exact on the
`(source_type, source_id)` pair in Postgres and narrowing on `source_id` in
Qdrant up to a stated cap. When the project holds nothing above the relevance
floor the answer **names the project and offers a one-tap widen**: never
silently widening, never silently refusing, which is the frozen research rule
(*the offer is the bridge*) applied to the lens. Projects are the scoping unit
for connectors, for findings reports (**schema 1.1**, additive: `project_id`
and `project_name` on the scope block, and a run enumerates exactly that
project's sources), for the Sources catalog, and for exactly two defaults (the
lens on or off, and an extraction policy folding into the existing
tightest-wins arithmetic through a port `ingestion` defines). **Deleting a
project never deletes its contents**: neither table is source-derived, so the
deletion saga has nothing to erase and only an assignment to release, and the
confirmation says so in those words. Read
[`docs/features/projects.md`](docs/features/projects.md) before changing
anything near the lens, and do not migrate the assignment onto memories.

Work proceeds through the V2 plan in order, with one owner-approved insertion,
now complete: **reasoning-model support** (Parts A, B and C, 2026-08-04).
Thinking is a CHANNEL, not content: `completeStream` yields channel-tagged
deltas, the budget charges thinking, redaction strips it fail-closed, chat
stores it (`chat_message.thinking`, migration 0044) and shows it as a
collapsed live disclosure, the answer-redaction cascade erases it with its
answer, and the trust-artifact id gains a probed `--reasoning` marker at
emission time only. Never captured, cited, verified, or evaluated:
[`docs/features/reasoning.md`](docs/features/reasoning.md).

## Delivery loop

Full details in [`docs/engineering-workflow.md`](docs/engineering-workflow.md).

1. **Open GitHub issues** for the unit of work, logically separated, under a shared
   label (`scripts/dev/create-issues.sh`).
2. **Branch**: `feature/<slug>`, `fix/<slug>`, or `chore/<slug>`.
3. **Implement.**
4. **Open a pull request** authored as the owner, with `Closes #N` for each issue.
   The title is a Conventional Commit.
5. **Required checks green**: `lint`, `boundaries`, `test`, `build`, `eval-gate`,
   `operator-smoke-fast`. Nothing merges without them. `scan`, `docker-build`
   and `operator-smoke-full` run but do not block, each for a reason written
   down in the job table in `docs/engineering-workflow.md`.
6. **Squash-and-merge.** The PR title becomes the single commit on `main`.
7. **Releases are cut by the owner** tagging `vX.Y.Z`.

Issue, branch, and pull-request operations are performed via `gh` as the owner.

## Coding conventions

TypeScript strict mode. ESLint + Prettier. dependency-cruiser enforces the module map
in CI (spec §15). Zod at every boundary. pino for logging: never memory content or tokens
in logs. Tests: Vitest (unit), Testcontainers (integration), Playwright (e2e).
Vocabulary per [`docs/glossary.md`](docs/glossary.md).

**House style for prose**: no em dashes and no en dashes in product copy or
documentation. Rewrite the sentence (comma, colon, period, restructure); never
substitute a mechanical hyphen. Enforced by the `lint` check.

## Definition of done

- `docker compose up` still reaches login on a fresh clone.
- CI module-boundary checks pass (spec §15); no cross-module table access.
- The binding invariant tests pass: scope-leak, deletion-cascade (spec §11.1),
  approval-gate, golden-set eval gate (spec §14).
- **Every string the feature added is a key, present in every locale**
  (`npm run i18n:check` is part of `lint`). A feature that ships English text
  hardcoded in a component, or a key only `en` has, is not done.
- Docs updated in the same change when behavior contradicts them.

## Needs owner sign-off (ask first)

- Any new dependency, framework, or the stack choice itself.
- Any deviation from a MUST rule in the specification.
- Git: **never run git commands unless explicitly asked.** The owner manages git.
- **NEVER add AI attribution to any git artifact. This is strictly forbidden.** No
  `Co-Authored-By` trailer, no "Generated with", no AI-authorship or "assisted by"
  line in commit messages, PR titles, PR bodies, issue text, or anywhere else. All
  commits and pull requests are authored solely by the owner, with no exceptions.
- Anything user-visible leaving the machine (publishing, external calls with real data).
