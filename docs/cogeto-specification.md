# Cogeto Specification

**Status.** This is one rulebook for the whole system. Some rules are already live; others are 2.0 targets tracked in [`cogeto-v2-plan.md`](cogeto-v2-plan.md). A MUST the code does not yet meet is a scheduled gap, not a licence to add new violations.

The normative rules of the system. MUST marks a rule whose violation is a defect. SHOULD marks a rule that may be traded off with a recorded decision. Numeric parameters are the values in force; changing one requires a decision record and a re run of the evaluation gates.

---

## 1. Ingestion

**1.1** Every source MUST be normalized by a registered reader into one text blob carrying reference time, owner and scope before any later stage runs.

**1.2** The reading layer MUST cover PDF, DOCX, plain text, mail, XLSX and CSV, and MUST attempt local optical character recognition on scanned or image only documents. Recognition MUST run inside the instance on CPU, with English and Croatian language packs.

**1.3** Where a local vision model is configured, poor scans, handwriting, tables and simple diagrams MAY be routed to the vision tier through the model gateway. Recovered text MUST enter the normal pipeline, including verification against the recovered span.

**1.4** A source that yields no readable text MUST be labelled as unreadable on its source record. It MUST NOT be reported as processed, and facts MUST NOT be produced for it.

**1.5** Before chunking, one anchoring call over the document opening, headers and filename MUST produce a source context containing subject entities, document class and revision, each marked confident or uncertain. The context MUST be stored on the source and injected into every chunk's extraction call.

**1.5.1** Where a document covers several subjects, section headings carry the per section subject, and the extractor MUST prefer the nearest explicit subject over the document default.

**1.5.2** Uncertain or multi valued context MUST fall back to the subject found in the text. Anchoring reduces ambiguity and MUST NOT invent a subject.

**1.5.3** The source context MUST be editable. Correcting it MUST re anchor that source's facts as supersessions rather than rewriting them in place.

**1.6** Extraction MUST be admission controlled per source and per connector, supporting enable and disable, fact budgets, retention, and admission rules over channels, folders and document classes.

**1.7** Observed third party content MUST pass injection defence before reaching the extraction prompt.

**1.8** Chunking: text at or under 6,000 characters passes whole; longer text splits at approximately 6,000 characters with 500 characters of overlap, preferring whitespace boundaries. Chunks MUST NOT be persisted.

**1.9** Extraction MUST return a `source_span` for every candidate fact, being a verbatim excerpt of the source. A candidate without a span MUST NOT be stored.

**1.10** Storage MUST occur in one idempotent transaction writing database rows before vector points, so a failed vector write rolls back the whole unit.

---

## 2. Verification

**2.1** Every candidate fact MUST be judged by a prompt family independent of the extraction family before storage.

**2.2** The verifier MUST receive only the candidate's own source span plus approximately 240 characters of surrounding context, and MUST NOT receive the whole document.

**2.3** A fact becomes `active` if and only if the verdict is supported AND the claim was not hedged in its source. Every other outcome MUST be stored as `uncertain`, with the single exception in 2.3.1.

**2.3.1** A candidate whose claim or whose source span is blank MUST NOT be stored. It has no content to remember and no provenance to inspect, so storing it would satisfy 2.3 while recording nothing. It MUST be recorded in the suppressed fact log with reason `structurally_invalid` under 2.6, so a withheld fact remains recoverable and explainable. This is the ONLY permitted non-admission: in particular, a source span the chunker cannot locate MUST NOT be treated as fabrication, because chunk boundaries can split a legitimate span.

**2.4** A claim omitted from a batched verification reply MUST be treated as unsupported: its recorded verdict is `unsupported` and it is never admitted `active`. Failure MUST NOT default to acceptance. Its uncertainty reason under 2.5 is `unjudgeable`, since support was not determined rather than judged absent.

**2.5** An `uncertain` fact MUST carry a distinguishable reason: hedged in source, partially supported, unsupported, or unjudgeable. The mapping from verification outcome to reason MUST be total: no outcome may fall through to a default.

**2.6** Every automatic demotion or suppression MUST write a suppressed fact log entry containing fact, source, span, reason and timestamp. The log MUST be queryable, visible on the source detail, and summarized in the findings report. Its entries carry source derived content, so they MUST be enumerated and erased by the deletion saga and counted in its receipt (11.1).

**2.7** There MUST NOT be a manual approval queue for facts. No fact may wait on human action in order to be stored, demoted or suppressed. A user MAY confirm an individual fact, which sets `user_approved` and outranks machine judgment thereafter; this MUST be an action on the fact, never a queue.

---

## 3. Status and lifecycle

**3.1** The status set is exactly `active`, `uncertain`, `contradicted`, `user_approved`, `outdated`, `replaced`.

**3.2** `contradicted` MUST be settable only by reconciliation.

**3.3** A `user_approved` fact MUST NOT be merged away by deduplication.

**3.4** Retrieval weights after the access gates MUST be: active 1.0, user approved 1.0, uncertain 0.6, contradicted 0.4, outdated 0.2, replaced 0. The `previous` temporal mode lifts outdated and replaced to 0.9.

**3.5** A contradicted fact cited in an answer MUST be shown with a conflict warning.

**3.6** A superseded fact MUST remain readable with its supersession chain intact.

**3.7** No lifecycle transition may delete a fact as a side effect. Deletion happens only through the deletion path.

**3.8** An obligation is the user's own only when the user wrote the words it was extracted from. Every source MUST record authorship structurally at read time: notes and captured chat are the user's own, uploaded documents and fetched pages are not, and mail is resolved from whether the message came from the user's own address. Authorship MUST NOT be a model judgement.

**3.9** Surfaces that present the user's standing obligations, the attention feed and the still-open answer alike, MUST read first-person facts only, through one shared read so they cannot diverge. An obligation stated in a third-party document remains a fact about that document: it is extracted, stored and retrievable as normal, and it MUST NOT be presented as something the user committed to. Unknown authorship is not the user's.

---

## 4. Scope and sensitivity

**4.1** Scope is `private` or `shared`. The `sensitive` flag is orthogonal to scope and to status, and any combination is valid.

**4.2** Both MUST be enforced inside the query, in the SQL predicate and in the vector store payload filter. Filtering results after fetching is a defect.

**4.3** The two gate implementations MUST remain semantically identical, and the equivalence MUST be covered by leak invariant tests.

**4.4** Scope assignment by entry point:

**4.4.1** Upload: explicit choice, defaulting to the user setting.

**4.4.2** Chat capture: private, stamped explicitly.

**4.4.3** Mail intake: the recipient default, with per sender and per alias routing rules.

**4.4.4** Connectors: inherited from the source system. A team readable container maps to shared; a personal or individually restricted item maps to that user's private context; an item restricted to a subset of users MUST be skipped and reported in the sync summary.

**4.5** Scope MUST NOT be inferred from document content by a model.

**4.6** Scope and sensitivity MUST be editable per source and per fact, MUST re stamp both stores, and MUST write an audit entry.

---

## 5. Reconciliation

**5.1** Candidate selection MUST be deterministic and model free. Only surviving pairs may cost a model call.

**5.2** Parameters in force:

| Parameter | Value |
|---|---|
| Candidate pool | Same owner and same scope, top 8 by similarity, best first |
| Check budget | At most 3 deduplication and 3 contradiction checks per fact per pass |
| Deduplication candidate | Cosine at or above 0.93, or entity overlap at or above 0.8 with identical kind |
| Contradiction candidate | Cosine in the band 0.80 to 0.93, or a related deduplication verdict; shared subject after alias resolution; kind in fact, decision, preference, commitment; other side active or user approved |
| Actions | At most one action per fact per pass |

**5.3** Deduplication MUST run before contradiction.

**5.4** Subject matching MUST resolve aliases, typos and cross language names. Byte equality is not sufficient.

**5.5** Numeric and unit comparison MUST run deterministically before the contradiction judge is consulted.

**5.6** A related deduplication verdict MUST escalate to contradiction judgement rather than terminating the pair.

**5.7** A `supersedes` verdict MUST be applied only when the winner is also temporally later, using stated validity where present and admission time otherwise. Any disagreement MUST downgrade to a human facing contradiction. A model verdict alone MUST NOT rewrite the timeline.

**5.8** A `contradicts` verdict MUST create a permanent relation carrying both spans, both sources and the detection date, and MUST set both facts to `contradicted`.

**5.9** `compatible` verdicts MUST be persisted in a checked pair ledger. A pair already judged compatible MUST NOT be re judged unless one of its facts changes.

**5.10** Similarity thresholds MUST be calibrated per embedding model and versioned with the reconciliation configuration.

**5.11** Pairing policy MUST ensure that simultaneous ingestion and crowded topics cannot permanently hide a true conflict. A conflict found later MUST carry its detection date.

**5.12** Contradictions MUST be surfaced in context: on the source, in any answer citing either side, and in the report. They MUST NOT be presented as a queue requiring triage.

---

## 6. Time

**6.1** Validity intervals are half open. The interval predicate MUST exist in exactly one place, in a pure form and an SQL form, and MUST be verified against a truth table.

**6.2** `valid_from` defaults to admission time or to the validity stated by the source. `valid_until` is closed by supersession, merge or edit.

**6.3** The nightly pass MUST move facts whose validity has lapsed to `outdated`.

**6.4** Relative temporal expressions MUST be resolved deterministically against the source reference time in the instance or user timezone. Unresolved expressions MUST be flagged, never guessed.

**6.5** Temporal retrieval modes MUST be explicit: `previous`, `point_in_time`, `change_since`. Mode MUST NOT be inferred from question phrasing.

---

## 7. Retrieval and answering

**7.1** The answer path MUST NOT perform side effecting writes.

**7.2** Query rewrite MUST classify the question, resolve references from conversation context, produce the search string, extract entities and select the temporal mode. Explicit commands MUST be matched deterministically before the model is consulted.

**7.3** Three search signals MUST run gated at source: vector, full text and trigram entity.

**7.4** Fusion MUST be reciprocal rank fusion with K of 60, followed by the status weights of rule 3.4.

**7.5** After fusion, the answer path MUST compute the score distribution across anchored entity clusters and act deterministically, with no user configuration and one behavior always:

**7.5.1** One dominant cluster: answer normally with citations.

**7.5.2** No cluster above the relevance floor: the answer MUST state that the corpus is silent, and MAY then continue with general model knowledge under an explicit banner marking it as not from the user's sources.

**7.5.3** Several comparable clusters with distinct subjects: the answer MUST fan out, one line per cluster with fact, citation and validation verdict where the question implies one, ending with a disambiguating question.

**7.5.4** A silent guess and a bare clarifying question are both defects.

**7.5.5** Cluster and relevance thresholds MUST be versioned with the retrieval configuration.

**7.6** Every claim in an answer MUST be either cited to a memory or marked unsourced. There MUST NOT be a mode in which model knowledge is presented as corpus knowledge.

---

## 8. Capture and surfaces

**8.1** Notes MUST be captured through chat. There is no standalone note field elsewhere in the interface.

**8.2** Files attached in chat MUST be ingested through the normal pipeline by default, and chat MUST confirm inline what was added and what conflicted.

**8.3** A transient toggle MUST keep an attached file conversation only, with nothing stored.

**8.4** The Sources surface MUST be read, audit and resolve only, except for deliberate upload and bulk import.

**8.5** Sources MUST present three levels:

**8.5.1** Sources list: one row per source with name, date, fact count and badges for contradictions, superseded and suppressed facts.

**8.5.2** Source detail: every extracted fact with status and exact source span, the editable anchoring context, and that source's suppressed fact log.

**8.5.3** Fact detail: extraction, verification verdict with its span, supersession chain, and which answers cited it.

**8.6** A filtered search view MUST span all facts by status, change date and content.

---

## 9. Bulk import

**9.1** Bulk import MUST accept a folder, archive or object storage path and MUST produce a manifest first, listing files, sizes and types and removing duplicates by content hash.

**9.2** Ingestion MUST run through the normal pipeline under per tenant concurrency caps so that one import cannot starve interactive work.

**9.3** Progress MUST be visible on Sources, and completion MUST produce one summary stating documents, facts, contradictions and superseded counts.

**9.4** Every imported fact MUST retain a pointer to its exact file, page and span.

---

## 10. Findings report

**10.1** A report MUST be produced over an explicitly selected set of sources.

**10.2** The header MUST state instance, corpus scope, date range, model configuration, and the trust scores for that configuration.

**10.3** Each contradiction MUST appear with both claims, both verbatim source spans, document with revision and location, detection date, and resolution status.

**10.4** The report MUST include superseded facts with their chains and a summary of the suppressed fact log for the selected scope.

**10.5** A finding with one side outside the selected scope MUST appear in a separately labelled boundary section, never silently included or silently omitted.

**10.6** Formats MUST be PDF for people and JSON for machines, and the artifact MUST be signed through the same path as deletion receipts.

---

## 11. Trust artifacts

**11.1** Deletion MUST run as a saga across the database, the vector index and object storage, and MUST emit an ed25519 signed receipt over a canonical count structure, hash chained to its predecessor.

**11.2** Receipt structures MUST remain backward compatible, so that receipts issued by earlier versions continue to verify.

**11.3** The nightly integrity sweep MUST detect orphans and tampering, and MUST NOT repair them.

**11.4** A complete signed export MUST be available on demand in an open, documented, versioned format.

**11.5** The audit log MUST be append only, enforced at the database level, and written in the same transaction as the action it records.

**11.6** Audit coverage MUST include reads: exports, file downloads and model gateway egress.

**11.7** Endpoints that verify or expose receipts MUST be gated to the requesting user's own scope.

---

## 12. Model gateway

**12.1** All model calls MUST pass through the gateway. A direct provider call from any module is a defect and is checked in continuous integration.

**12.2** All outbound text MUST pass the redaction decorator, embeddings included, and the decorator MUST fail closed.

**12.3** Prompt families MUST be immutable and versioned. A prompt change is a new version.

**12.4** Tier selection is a property of the call site: pipeline tier for extraction, verification, reconciliation, rewrite and titling; answer tier for chat, research synthesis and briefs; embedding tier for vectors; vision tier for hard scans.

**12.5** Provider and model configuration MUST live in the database with encrypted keys. The master key stays in the environment, which otherwise holds only bootstrap values.

**12.6** The chat model MUST be user switchable. Extraction and verification models MUST be administrator only, each shown with the trust scores measured for that configuration, and untested combinations MUST be flagged as not evaluated.

**12.7** Token usage MUST be recorded per operation and rolled up per user, per instance and per period, broken down by task family.

**12.8** Any cost comparison shown to a user MUST state a documented, checkable baseline methodology.

---

## 13. Interface and language

**13.1** The interface MUST support user level language selection for English, Croatian and German, with English as default and fallback.

**13.2** All interface strings MUST live in key files, and the build MUST fail on a missing or orphaned key.

**13.3** Dates and numbers MUST follow the user locale.

**13.4** Interface language support MUST NOT be presented as extraction quality. Extraction quality is stated per language on the trust page.

---

## 14. Evaluation

**14.1** Every capability MUST ship with golden cases and gates.

**14.2** Gates MUST run in continuous integration, including on pull requests through cached model responses.

**14.3** Floors MUST apply per language, so that a weaker language cannot be masked by an aggregate.

**14.4** Contradiction precision and recall, supersession, verification agreement, extraction precision and recall, deduplication accuracy, anchoring, ambiguity handling and query rewriting MUST each be measured and gated.

**14.5** The corpus MUST include a vertical set drawn from real regulatory or requirements documents, and pairs covering numeric, unit and cross language conflicts.

**14.6** Trust scores MUST be published per release and per model configuration, including unflattering results.

**14.7** Gates ratchet upward. A metric drop beyond two points MUST have a recorded decision.

---

## 15. Architecture rules

**15.1** A boundary is imports plus table ownership plus job type contracts plus dependency injection tokens. Import checking alone is not boundary enforcement.

**15.2** A module MUST NOT write to another module's tables, and barrels MUST NOT re export live tables.

**15.3** Source types MUST be registered rather than enumerated in a database type.

**15.4** The API process MUST NOT perform side effecting writes. Mutations go through the outbox and the worker.

**15.5** Isolation between tenants is a deployment boundary. A shared storage multi tenant mode is out of scope.

**15.6** Projects organize conversations, files and research runs. Memory remains one shared pool, and a per project gate dimension on memory is out of scope.

**15.7** Customer knowledge MUST NOT be used to train models. Only labelled verdicts and structural features may leave an instance, and only with explicit opt in.
