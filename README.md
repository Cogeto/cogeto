<p align="center">
  <img src="assets/brand/cogeto-final-logo-horizontal.svg" alt="Cogeto" width="360">
</p>

# Cogeto

A private, EU-hosted AI command center that turns scattered work context into trusted, correctable long-term memory — and runs human-approved agents on top of it.

> **Cogeto, ergo sum — your mind, extended.**

## What is Cogeto

Cogeto ingests your scattered work context — email, calendar, notes, documents — and turns it into **correctable, inspectable long-term memory** rather than just stored text. Every fact carries a lifecycle status (active, outdated, contradicted, uncertain, replaced, user-approved) plus an orthogonal sensitive flag, is scope-tagged, and stays source-linked, so you can trust it and correct it. Human-approved agents then act on that memory with a human in the loop.

It is **EU-first, privacy-first, self-hostable, and model-agnostic (Mistral-first)**. The moat is the correctable, inspectable memory — not the storage. Primary users are privacy-conscious solo professionals: consultants, founders, freelancers, and small teams.

## Repo layout

- `project/` — the Cogeto product (skeleton only for now).
- `docs/` — authoritative product specification and scope.
- `assets/` — brand assets (logo, icon); trademarked, see [`TRADEMARK.md`](TRADEMARK.md).
- `tests/` — **intentionally unused** (folder marker only, gitignored).

## Status

**Session 3 complete (S3-A + S3-B).** On top of the Session 1–2 foundation
(compose stack to login, contractual schema, outbox + idempotent queue, the
six-stage Notes pipeline with versioned prompts and the bilingual golden set),
Cogeto now **answers and governs**:

- **Hybrid retrieval** (§A.5): vector (Qdrant) + keyword FTS (`simple` +
  unaccent) + trigram entity match, fused with reciprocal rank fusion, status
  multipliers on top — scope and sensitive stay hard in-query gates.
- **Chat**: `POST /api/chat` streams grounded answers (prompt family
  `answer/v0001`) that cite only retrieved facts; citation chips carry the
  memory's status and deep-link into the governance drawer; zero retrieval
  yields an honest "nothing on record", never invention.
- **Governance dashboard**: the governed Memories list (search, filters,
  entity tags), a detail drawer with provenance, verification verdict,
  supersession history and actions (approve / mark outdated / sensitive
  toggle / edit-as-supersession / reject), the **Review** queue for uncertain
  facts, and a **System** view with queue health and dead-letter retry. Every
  action writes `audit_log` with the acting principal.

Reconcile (dedup/contradiction), the deletion saga, and the CI eval gates
arrive in Session 4. `npm run reindex` and `npm run eval` remain the
operational contracts (results in `docs/eval/history.md`).

## Licensing

- **Core** is licensed under **AGPLv3** — see [`LICENSE`](LICENSE).
- **Contributions** require a **CLA** — see [`CLA.md`](CLA.md).
- **Commercial licenses** (AGPL exemption) are available — see [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md).
- The **"Cogeto" name and logo** are trademarks — see [`TRADEMARK.md`](TRADEMARK.md).
