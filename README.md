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

**Session 3.5 complete (quality hardening, S3.5-A + S3.5-B).** On top of the
Session 1–3 foundation (compose stack to login, contractual schema, outbox +
idempotent queue, the six-stage Notes pipeline, hybrid retrieval, grounded chat,
and the governance dashboard), Cogeto's memory quality is hardened against real
owner-testing failures:

- **Grounded, complete chat**: conversational query rewriting resolves pronouns
  ("who is she?") against recent turns; an **entity-profile** retrieval mode
  gathers everything about a person and answers with a full profile; project
  questions aggregate the whole picture. Answers describe the world (never the
  retrieval), and a fact about Ana that mentions Marta is never conflated.
- **Deterministic dates**: relative expressions ("by Monday", "in two weeks")
  are resolved by code against the note anchor, not guessed by the model.
- **Honest uncertainty**: hedged source wording ("might", "not sure") admits a
  memory as *uncertain* and is shown with soft framing; plainly stated facts stay
  *active* — the verifier judges support only.
- **Leak-proof citations**: one grammar (`{{cite:uuid}}`); any other bracketed
  token is stripped before it can reach the user.
- **Per-task model tiers**: a cheaper model for high-volume ingestion, a stronger
  one for user-facing answers.
- **Two eval harnesses**: `npm run eval` (golden set, extraction + verification)
  and `npm run eval:chat` (scripted conversations scored end-to-end), both
  recorded to `docs/eval/history.md`.

Reconcile (dedup/contradiction), the deletion saga, and the CI eval gates arrive
in Session 4. `npm run reindex` and the two eval commands are the operational
contracts. Retrieval/answer/extraction prompts are versioned artifacts under
`project/prompts/` (currently extraction/verification/answer at v0002).

## Licensing

- **Core** is licensed under **AGPLv3** — see [`LICENSE`](LICENSE).
- **Contributions** require a **CLA** — see [`CLA.md`](CLA.md).
- **Commercial licenses** (AGPL exemption) are available — see [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md).
- The **"Cogeto" name and logo** are trademarks — see [`TRADEMARK.md`](TRADEMARK.md).
