<p align="center">
  <img src="assets/brand/cogeto-final-logo-horizontal.svg" alt="Cogeto" width="360">
</p>

# Cogeto

Cogeto is a **private, EU-hosted AI command center for professionals**: it turns
your scattered work context (notes, email, documents) into long-term memory you
can inspect, correct, and provably delete. Every trust claim is backed by an
**inspectable artifact**: a signed receipt, a verification verdict, a validity
interval, a source link. Never just a promise. It is self-hostable,
single-tenant by design, and model-sovereign: EU-hosted Mistral by default,
with an optional local redaction tier so PII never leaves your machine.

> **Cogeto, ergo sum: your mind, extended.**

## The four signature mechanisms

- **Deletion receipts.** Deleting a source runs a saga across Postgres, Qdrant,
  and MinIO and issues a **hash-chained, ed25519-signed receipt**; a nightly
  integrity sweep re-verifies that everything a receipt promises gone *stays*
  gone. Forgetting is provable, not promised.
- **Self-verified extraction.** Every extracted fact passes an independent
  verification pass before it counts, and carries a lifecycle status (`active`,
  `uncertain`, `contradicted`, `outdated`, `replaced`, `user_approved`);
  contradictions surface side-by-side for *you* to resolve. Nothing is silently
  believed.
- **Time-travel memory.** Facts carry validity intervals, supersession never
  destroys history, and the timeline shows what you believed at any point and
  what changed it. "Which CRM were we using in March?" is answered as the past,
  never stated as the present.
- **The Memory Passport.** One click exports everything (all facts with full
  history, statuses, provenance, tasks, and your deletion receipts) as a signed
  archive in a [published open format](docs/passport-schema/). Independently
  verifiable outside Cogeto. Leave whenever you want.

## Quickstart

One command on a fresh clone is the contract:

```sh
git clone https://github.com/Cogeto/cogeto.git
cd cogeto
docker compose up
```

Wait for the stack to become healthy, then open **https://localhost** (the dev
edge uses a self-signed certificate, so accept the warning) and sign in with
the dev bootstrap admin, `admin@cogeto.localhost` / `DevPassword1!`. Zero
configuration required; every default can be overridden via `.env` (see
[`.env.example`](.env.example)). Model features (chat, extraction) need a
[Mistral API key](https://console.mistral.ai) in `COGETO_MISTRAL_API_KEY`.
Without one the stack still runs, and model calls fail with a typed error
instead of pretending. Details, layout, and common issues:
[`docs/running-locally.md`](docs/running-locally.md).

### The Ana sandbox (a pre-populated demo world)

```sh
COGETO_DEMO_MODE=1 docker compose --profile demo up --build
```

This seeds a fictional consultant ("Ana Kovač") with weeks of accrued memory
through the real public API: contradictions to resolve, lapsed facts, derived
tasks, a signed deletion receipt. The sandbox is gated behind a generated
password (printed by the seed job: `docker compose logs demo-seed`). Never run
the demo profile on an instance holding real data.

## Architecture at a glance

Two processes from one codebase, an **app** (API + SPA, the fast path:
retrieval and answering only) and a **worker** (every slow job: extraction,
verification, reconciliation, the deletion saga, nightly dreaming and integrity
sweeps), connected by a transactional outbox and an idempotent job queue, so
nothing is ingested and silently unprocessed.

**Postgres is the source of truth; Qdrant is a rebuildable index** (a `reindex`
command reconstructs it at any time); original files live in MinIO under
SSE-encrypted, tenant-scoped keys; Zitadel provides identity; Caddy terminates
TLS. Facts, not raw documents, are what's stored and searched. One instance =
one tenant: isolation is a deployment boundary, not a row filter.

Deeper reading: the [technical architecture](docs/Cogeto-Technical-Architecture.md),
the binding [architecture decisions](docs/Cogeto-v1-Addendum-Verifiable-Memory.md),
and the [decision records](docs/decisions/).

## Sovereignty and the model story

All model and embedding calls go through a single **model-gateway seam**; no
provider SDK appears anywhere else. The default provider is **Mistral
(EU-hosted)**, with per-task tiers: a cheap model for high-volume ingestion, a
stronger one for answers you read. The optional **redaction tier**
(`--profile redaction`) runs a local, CPU-only NER sidecar that pseudonymizes
sensitive entities *before any external model call* and re-identifies the
response. It **fails closed** if unreachable: plaintext is never sent. Your
data lives in your instance's Postgres/MinIO/Qdrant; nothing about the
architecture phones home.

## Links

- **Website:** [cogeto.eu](https://cogeto.eu), including the whitepaper
- **Documentation:** [`docs/`](docs/README.md) with specs, decisions, schemas, runbooks, audits
- **Security and safety:** [`docs/security/`](docs/security/README.md) — how the protections work, the public audits, and how to verify them (single entry point)
- **Run it locally:** [`docs/running-locally.md`](docs/running-locally.md)
- **Deploy it:** [`docs/deployment.md`](docs/deployment.md)

## License and trademark

The core is **AGPLv3** ([`LICENSE`](LICENSE)); commercial licenses (an AGPL
exemption) are available ([`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md)).
The **Cogeto name and logo are trademarks** and are *not* covered by the code
license; see [`TRADEMARK.md`](TRADEMARK.md) and
[`assets/brand/README.md`](assets/brand/README.md). Maintainership and IP:
[`MAINTAINERS.md`](MAINTAINERS.md).

## Contributing

Contributions are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) (the
delivery loop, running the tests and the eval harness, golden-set rules) and
note that contributions require accepting the [CLA](CLA.md) with a single PR
comment; the reasoning is stated there honestly. Security reports:
[`SECURITY.md`](SECURITY.md); how the protections work and how to verify them:
[`docs/security/`](docs/security/README.md).
