# Cogeto Technical Architecture

Cogeto is a single tenant knowledge system. It reads documents, extracts atomic factual claims with exact provenance, verifies every claim against its own source text before storing it, reconciles it against everything already stored, tracks its validity over time, answers questions from the result with citations, and produces signed artifacts that let a third party check all of it.

One architectural idea shapes the whole system: **the write path is a gate, not a conveyor.** Nothing enters memory unverified, every fact carries the span it came from, and every state change that matters is recorded.

---

## 1. Deployment

One container image runs as two processes.

**API process.** NestJS over HTTP and server sent events. It serves the fast path only: retrieval and answering. It performs no side effecting writes.

**Worker process.** Graphile Worker. It executes the ingestion pipeline, the deletion saga, nightly jobs, exports, and every other mutation, idempotently.

Every mutation with side effects is written to a transactional outbox row and executed by the worker. An interrupted request cannot leave a half ingested document behind, and every operation has exactly one place where it is retried.

### 1.1 Services per tenant

One tenant is one deployment. There is no shared database, no tenant discriminator column, and no cross tenant query path. Isolation is a deployment boundary.

| Service | Role |
|---|---|
| PostgreSQL | The truth: facts, sources, relations, audit log, outbox, job queue |
| Qdrant | Vector index, a rebuildable derivative of Postgres and never authoritative |
| MinIO | Object storage for uploaded files and export bundles |
| Zitadel | Identity over OIDC, and the mechanism for SAML, SCIM and identity provider federation |
| Haraka | Receive only SMTP intake for forwarded mail |
| Caddy | TLS termination and reverse proxy |
| SearXNG | Self hosted search for the research path |
| Redaction sidecar | CPU only pseudonymization of outbound model text |

Idle footprint is approximately 1.3 GB per tenant, which makes one container per customer economically viable at small scale.

### 1.2 Model presets

**Hosted.** Pipeline tier `mistral-small-latest`, answer tier `mistral-medium-latest`, embeddings `mistral-embed` at 1024 dimensions.

**Local and offline.** All language tiers served by a local runtime, embeddings by `bge-m3`, also 1024 dimensions. The instance makes no outbound network calls in this configuration. A vision model in the same runtime reads scans that optical character recognition cannot handle.

Provider and model configuration lives in the database with encrypted keys. The master key stays in the environment file, which otherwise carries only bootstrap values: database credentials and instance configuration.

### 1.3 Two stack choices worth stating

**The frontend is a static SPA, deliberately not a server rendered framework.** Cogeto is an authenticated tool behind a login: no search indexing, no crawlable pages, no first paint problem. A rendering framework would add a per tenant Node process and a second half backend that blurs the single backend boundary. Instead Vite builds React to static files at image build time, Caddy serves them and reverse proxies the API and auth paths on the same origin so there is no cross origin configuration, and types are shared from a common package so an API change that breaks the interface fails at compile time. The SPA never handles credentials; it redirects to the identity provider.

**Python appears only as a sidecar, never inside the monolith.** Model work here is HTTPS calls, prompt assembly and schema parsing of structured output. No tensors, no GPU code, no training. That belongs in TypeScript inside the model gateway, so extraction output types are memory input types checked at compile time. Python appears only where local model execution genuinely happens, always as an isolated container behind the gateway. Today that is the redaction sidecar.

Accepted consequences: no separate cache or message broker, and no server rendering runtime.

---

## 2. Module structure

| Module | Responsibility |
|---|---|
| `memory` | The memory store: fact lifecycle, status transitions, three search primitives, point in time reads, the deletion saga and receipts, reconciliation state, the integrity sweep, vector and object stores |
| `ingestion` | Pipeline stages, the nightly pass, the temporal resolver, dormancy, evaluation harnesses |
| `retrieval` | Search, fusion, ranking, ambiguity analysis |
| `chat` | Conversation orchestration, intent handlers, capture, streaming |
| `sources` | Readers per source type, anchoring, the extraction gate, bulk import |
| `connectors` | External systems: mail, files, web research, named skills |
| `agents` | The approval state machine and executor for actions requiring human sign off |
| `reporting` | The findings report assembler and its signing path |
| `identity` | The identity seam, default deny guard, principal resolution |
| `model-gateway` | The single outbound model egress, provider adapters, tier routing, redaction and budget decorators, the immutable prompt registry |
| `passport` | The signed full export assembler |
| `infrastructure` | Database, outbox, queue, audit log, limits |

**Boundary contract.** A boundary is imports plus table ownership plus job type contracts plus dependency injection tokens. A module reads and writes only its own tables; cross module data movement happens through published interfaces and typed job contracts. Source types are registered rather than enumerated in a database type, so adding a reader or a connector touches only that module.

Production imports form an acyclic layering:

```
infrastructure -> identity -> model-gateway -> memory -> ingestion
   -> retrieval -> chat -> sources -> connectors -> agents -> reporting
```

---

## 3. The ingestion pipeline

One source becomes zero or more stored facts.

```
read -> anchor -> chunk -> extract -> verify -> embed and store -> reconcile
```

### 3.1 Read

A registered reader per source type normalizes input into one text blob carrying reference time, owner and scope.

The reading layer covers PDF and DOCX text, spreadsheets in XLSX and CSV (sheets and tables flattened into extractable statements), plain text and mail, and scanned or image only PDFs. Scans pass first through local optical character recognition, running on CPU inside the instance with English and Croatian language packs. Where a local vision model is configured, hard cases such as poor scans, handwriting, tables and simple diagrams are read by the vision tier through the model gateway. Recovered text enters the pipeline unchanged, so it is extracted, verified against the recovered span, and given provenance to the file and page like any other text.

A file that yields nothing readable is labelled as unreadable on its source record. It is never reported as processed and no facts are invented for it.

### 3.2 Anchor

Before chunking, one model call over the document's opening pages, title block, headers and filename produces the **source context**: the subject entities the document is about (product models, project names, parties), the document class (datasheet, specification, manual, contract), and the revision. Each element is marked confident or uncertain.

The context is stored on the source and injected into every chunk's extraction call. A sentence reading only "the device has one antenna" therefore becomes a fact about model AAA rather than about a generic device. Where a document covers several subjects, section headings carry the per section subject and the extractor prefers the nearest explicit subject over the document default. Where the context is uncertain or multi valued, extraction falls back to the plain subject found in the text, so anchoring reduces ambiguity and never invents a subject.

The source context is visible on the source detail and editable. Correcting it re anchors that source's facts as supersessions, preserving the chain.

### 3.3 Extraction gate

Extraction is admission controlled per source and per connector: it can be enabled or disabled, given fact budgets and retention rules, and restricted by admission rules such as which channels, folders or document classes are eligible. Observed third party content passes injection defence before it reaches the extraction prompt.

### 3.4 Chunk

Text at or under approximately 6,000 characters passes whole. Longer text splits at approximately 6,000 characters with 500 characters of overlap, preferring whitespace boundaries. Chunks are transient values and are never stored.

### 3.5 Extract

One pipeline tier call per chunk returns atomic candidate facts. Each carries the claim, its kind (fact, decision, preference, commitment or open loop), the subject entity, other entities, a hedged flag, temporal expressions, and a **source span**: the verbatim excerpt of the document that supports the claim. The span is the provenance anchor for everything downstream.

### 3.6 Verify

An independent prompt family re reads only the candidate's own source span plus approximately 240 characters of surrounding context and judges whether that evidence supports the claim. It does not receive the whole document, so it judges evidence rather than re extracting. Verdicts are supported, partial and unsupported. Claims omitted from a batched reply count as unsupported, so failure never defaults to acceptance. Calls are batched at ten claims each.

A claim becomes `active` only if the verdict is supported and the claim was not hedged in its source. Everything else becomes `uncertain`, carrying a distinguishable reason: hedged in source, unsupported, or unjudgeable. Every demotion writes a **suppressed fact log** entry with fact, source, span, reason and timestamp, which is queryable, shown on the source detail, and summarized in the findings report.

There is no manual approval queue. Cogeto resolves these outcomes itself and leaves the record behind.

### 3.7 Embed and store

One batched embedding call covers the source's admitted facts. Storage happens in a single idempotent transaction that writes Postgres rows before Qdrant points, so a failed vector write rolls back the entire unit. Each vector point carries a payload copy of owner, scope, status, sensitive flag, source type, source identifier and validity end, which is what allows the access gate to run inside the vector query.

### 3.8 Reconcile

Candidate selection is deterministic and model free; only surviving pairs cost a model call.

**Deduplication runs first.** Candidates are pairs at cosine similarity 0.93 or above, or with entity overlap of 0.8 or above and identical kind. The judge returns same fact, distinct or related. On same fact one row survives, a user approved fact is never merged away, the loser becomes `replaced` with a supersession pointer, and its validity interval closes.

**Contradiction runs second.** Candidates are pairs in the similarity band 0.80 to 0.93, or pairs the deduplication judge marked related, sharing a subject entity after alias, typo and cross language resolution, of kind fact, decision, preference or commitment, with the other side active or user approved. Numeric and unit comparison runs deterministically before the judge is consulted, so differing quantities and units are caught rather than left to a model instructed to prefer compatibility. The judge returns contradicts, compatible or supersedes.

On **contradicts**, both facts become `contradicted` and are linked by a permanent relation carrying both spans, both sources and the detection date. On **supersedes**, the older fact is closed only if the winner is also temporally later; when the model verdict and the timeline disagree, the pair becomes a human facing contradiction rather than a silent rewrite.

**Compatible verdicts are persisted** in a checked pair ledger, so a pair judged compatible is not re judged on later passes unless one of its facts changes. This keeps borderline pairs stable over time and removes recurring cost.

Similarity thresholds are calibrated per embedding model and versioned with the reconciliation configuration. The pairing policy ensures that simultaneous ingestion and crowded topics do not hide a true conflict, and a conflict found later carries its detection date so a report can state when it appeared.

### 3.9 Nightly pass

The same reconciliation engine runs in batch across the corpus, facts whose validity has lapsed become `outdated`, dormancy flags update, and the digest is composed by deterministic assembly with no model call.

---

## 4. Retrieval and answering

```
question -> rewrite -> three gated searches -> fusion and ranking -> ambiguity analysis -> answer
```

**Rewrite.** One pipeline tier call classifies the question, resolves references from conversation context, produces the search string, extracts entities, and selects the temporal mode. Explicit commands are matched deterministically before the model is consulted.

**Search.** Three signals run in parallel, each gated at source: vector search in Qdrant with payload pre filters, full text search in Postgres, and trigram entity matching.

**Fusion and ranking.** Reciprocal rank fusion with K of 60, then status weights on top of the hard gates: active and user approved at 1.0, uncertain at 0.6, contradicted at 0.4 with a warning shown to the user, outdated at 0.2, replaced at 0. The `previous` temporal mode lifts outdated and replaced to 0.9.

**Ambiguity analysis.** The answer path computes the score distribution across anchored entity clusters and acts deterministically, with no user configuration and one behavior always. A single dominant cluster answers normally with citations. No cluster above the relevance floor means the corpus is silent: the answer says so, then continues with general model knowledge under a banner marking it as not from the user's sources. Several comparable clusters with distinct subjects produce a fan out answer, one line per cluster with fact, citation and validation verdict where the question implies one, ending with a disambiguating question. Thresholds are versioned like the reconciliation configuration, and the analysis costs no extra model call.

**Answer.** One answer tier call composes the response with a per claim citation grammar. Each claim either links to a memory or is marked unsourced. Contradicted facts carry their warning into the answer. The response streams over server sent events.

Temporal modes are explicit rather than inferred from phrasing: `previous`, `point_in_time` and `change_since` route to the store's temporal reads.

---

## 5. Access gates

Access control is enforced inside the query and never applied to results after fetching.

**SQL side.** One predicate: the owner is the caller, or the scope is shared, together with the sensitive rule.

**Vector side.** The same predicate expressed as Qdrant payload pre filters, using the payload copy each point carries.

Scope, `private` or `shared`, decides who may see a fact. The `sensitive` flag is an orthogonal axis deciding how carefully the system surfaces a fact, so any combination of the two is valid. Both are hard gates rather than ranking adjustments.

Scope is assigned deterministically, never inferred from content. Uploads take an explicit choice defaulting to the user setting. Chat capture is private and stamped explicitly. Mail intake follows the recipient default and per sender routing rules. Connectors inherit the source system's own permissions: a team readable space maps to shared, a personal or individually restricted item maps to that user's private context, and an item restricted to a subset of users is skipped and reported in the sync summary. Scope and sensitivity are editable per source and per fact, re stamp both stores, and write an audit entry.

---

## 6. Model gateway

Every model call passes through one seam, enforced in continuous integration. No module calls a provider directly.

**Adapters.** Mistral, OpenAI compatible endpoints, Anthropic, and a local runtime.

**Tiers.** Pipeline tier for extraction, verification, reconciliation, rewrite and titling. Answer tier for chat, research synthesis and briefs. Embedding tier for vectors. Vision tier for hard scans. The tier is a property of the call site.

**Decorators.** Redaction runs first and fails closed, covering all outbound text including embeddings. Budget and token accounting follow, recording usage per operation and rolling it up per user, per instance and per period, broken down by task family.

**Prompt registry.** Prompt families are immutable and versioned; a change is a new version rather than an edit.

**Administration.** An admin page manages providers and models. The chat model is user switchable. Extraction and verification models are administrator only, each shown with the trust scores measured for that configuration, and untested combinations are flagged as not evaluated.

---

## 7. Trust machinery

**Deletion saga.** Deletion cascades per origin across Postgres, Qdrant and object storage, then emits an ed25519 signed receipt over a canonical count structure, hash chained to its predecessor and verifiable without trusting the instance.

**Integrity sweep.** A nightly pass detects orphans and tampering across the three stores. It reports and never repairs, because a system that silently corrects itself cannot be audited.

**Memory Passport.** A signed, complete export of facts, history and receipts in an open, documented format. Leaving is a supported operation.

**Audit log.** Append only, enforced by a database trigger that rejects updates and deletes, written in the same transaction as the action it records. Coverage includes reads: passport exports, file downloads and model gateway egress. The log has a retention policy and an export path.

**Findings report.** A signed, printable artifact produced over a selected set of sources. The header states instance, corpus scope, date range, model configuration and that configuration's trust scores. Each contradiction appears with both claims, both verbatim spans, document with revision and location, detection date and resolution status. Superseded facts appear with their chains, followed by a summary of the suppressed fact log for that scope. Findings with one side outside the selected scope appear in a separately labelled boundary section. The report is produced as PDF for people and JSON for machines, signed through the same path as deletion receipts.

---

## 8. Bulk import

Cogeto ingests a folder, archive or object storage path in one operation. A manifest is produced first, listing files, sizes and types and removing duplicates by content hash. Ingestion is then queued through the normal pipeline under per tenant concurrency caps, so a large import cannot starve interactive work. Progress is visible on the Sources page, and completion produces one summary stating documents, facts, contradictions and superseded counts. Every fact keeps its pointer to the exact file, page and span it came from.

---

## 9. Surfaces

**Chat** is where knowledge enters and questions are asked. Notes are captured in conversation. Files attach by paperclip and are ingested through the normal pipeline by default, with inline confirmation of what was added and what conflicted. A toggle keeps an attached file transient and conversation only.

**Sources** is where knowledge is inspected and proven, in three levels. The sources list shows one row per document, note or message with name, date, fact count and badges for contradictions, superseded and suppressed facts. The source detail shows every extracted fact with its status and exact span, the editable anchoring context, and that source's suppressed fact log. The fact detail shows the full lifecycle: extraction, verification verdict with its span, supersession chain, and which answers cited it. A filtered search view spans all facts by status, change date or content.

**Findings and reports** present contradictions in context and produce the signed artifact. **Administration** covers providers and models, jobs, audit and instance settings.

The interface supports user level language selection for English, Croatian and German, with English as default and fallback. All strings live in key files with a synchronization check in the build, and dates and numbers follow the user locale.

---

## 10. Offline operation

Cogeto runs fully inside a customer network with no outbound connectivity. Language and embedding models run in the local runtime, optical character recognition runs on CPU in the instance, search is self hosted, storage is local, and there is no telemetry. The single model egress seam is what makes this verifiable rather than asserted: there is one place where a call could leave, and it is enforced in continuous integration. The instance ships as an offline image bundle for environments where even image pulls are unavailable.

---

## 11. Evaluation

Cogeto measures itself against a labelled golden corpus covering English and Croatian, with cases for extraction, verification, deduplication, contradiction, supersession, anchoring, ambiguity handling, query rewriting and chat answering, including a vertical set drawn from real regulatory and requirements documents and pairs covering numeric, unit and cross language conflicts.

Gates run in continuous integration, including on pull requests through cached model responses. Floors apply per language, so a weaker language cannot be hidden inside an aggregate. Every release publishes its trust scores, and every model configuration carries its own scores, which is why the administration page can show a configuration's measured quality and flag untested combinations. Gates ratchet upward, and a metric drop beyond two points requires a recorded decision.
