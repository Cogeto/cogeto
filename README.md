<p align="center">
  <img src="assets/brand/cogeto-final-logo-horizontal.svg" alt="Cogeto" width="360">
</p>

# Cogeto

Cogeto turns your documents into **verified, provable institutional memory**: it
reads document sets including scans, verifies every fact against its own source
sentence before storing it, reports where your documents contradict each other, and
produces a signed findings report a third party can verify. Runs EU hosted, self
hosted, or fully offline. Open source under **AGPLv3**.

Every trust claim is backed by an **inspectable artifact**: a signed receipt, a
verification verdict, a validity interval, a source link. Never just a promise. It is
single-tenant by design and model-sovereign, with an optional local redaction tier so
PII never leaves your machine.

> **Models are rented. Knowledge is owned.**

## What makes it different

- **Contradiction findings.** Every new fact is reconciled against everything already
  known, across the whole corpus: the specification against the mail against the
  minutes against the scan. Where documents disagree, Cogeto reports the conflict with
  both claims and their sources. Contradictions are surfaced, never queued.
- **Verification before storage.** Every extracted fact passes an independent
  verification pass against its own source span before it counts, and carries a
  lifecycle status. What fails is handled automatically and logged, never silently
  dropped. Nothing is silently believed.
- **The signed findings report.** A forwardable artifact an auditor or quality lead
  can hand on: every contradiction with both verbatim source spans, superseded facts
  with their chains, and a summary of what verification rejected. Signed, so a third
  party can check it.
- **Per-claim provenance.** Answers cite their sources sentence by sentence. Memory
  claims carry inspectable chips, web claims carry URL and fetch time, and anything
  from the model's own knowledge is plainly marked **unsourced**. That marking is the
  feature: chat is how the corpus is used, and every answer says exactly what it can
  back up.
- **Time-travel memory.** Facts carry validity intervals, supersession never destroys
  history, and the timeline shows what you believed at any point and what changed it.
  "Which CRM were we using in March?" is answered as the past, never as the present.
- **Deletion receipts.** Deleting a source runs a saga across Postgres, Qdrant, and
  MinIO, then issues a **hash-chained, ed25519-signed receipt**. A nightly sweep
  re-verifies that what a receipt promised gone *stays* gone. Forgetting is provable.
- **The Memory Passport.** One click exports everything, with full history, statuses,
  provenance, and your receipts, as a signed archive in a
  [published open format](docs/passport-schema/) that verifies outside Cogeto.

## Two ways to run it, and they are not interchangeable

|  | **Try it / develop on it** | **Run a real instance** |
| --- | --- | --- |
| How | `docker compose up` in a clone | `sudo ./cogeto install` on a server |
| Where | **your own machine only** | a server you control |
| Secrets | committed dev defaults, published in this repository | generated per instance at install |
| Images | built from your working tree | prebuilt, cosign-verified per release |
| Data | throwaway | the real thing, with backups and upgrades |

**The compose stack is for local evaluation and development. It is not a
deployment method and never becomes one.** Its passwords are in this
repository, so anyone who reads it can sign into a copy of it. Bringing it up
on a server is not a supported path and not a shortcut to one, whatever hostname
you point at it.

A server instance is installed and operated with the **operator script**, which
generates every secret locally, pulls signed images, and ends each run by
printing exactly what you must still do yourself. See
[deployment](docs/deployment.md) and [operations](docs/operations/).

### Quickstart: on your own machine

One command on a fresh clone is the contract:

```sh
git clone https://github.com/Cogeto/cogeto.git
cd cogeto
docker compose up
```

Wait for the stack to become healthy, then open **https://localhost** (the dev edge
uses a self-signed certificate, so accept the warning) and sign in with the dev
bootstrap admin, `admin@cogeto.localhost` / `DevPassword1!`. Those credentials are
the same on every clone in the world, which is the point and also the reason this
stack belongs on `localhost` and nowhere else. Zero configuration required; every
default can be overridden via `.env` (see [`.env.example`](.env.example)). Model
providers are configured in the interface after login and stored encrypted in the
instance database; without one the stack still runs, and the interface says plainly
what to do.

Details, layout, and common issues: [`docs/running-locally.md`](docs/running-locally.md).

### Installing a server instance

```sh
# On a fresh Ubuntu 22.04/24.04 host you control:
curl -fsSL https://raw.githubusercontent.com/Cogeto/cogeto/main/scripts/operator/cogeto -o cogeto
chmod +x cogeto
sudo ./cogeto install --check --domain <your.domain> --acme-email <you>  # dry run first
sudo ./cogeto install --domain <your.domain> --acme-email <you>
```

It installs Docker and cosign, verifies the release signatures, generates every
per-instance secret into a `600` `.env`, brings the stack up, and prints the DNS
records, backup settings and verification steps it cannot do for you. Full
procedure, including backups and upgrades:
[docs/deployment.md](docs/deployment.md).

### The Ana sandbox

```sh
COGETO_DEMO_MODE=1 docker compose --profile demo up --build
```

A fictional consultant with weeks of accrued memory, seeded through the real public
API: contradictions to resolve, lapsed facts, standing commitments, a signed deletion
receipt. Gated behind a generated password printed by the seed job
(`docker compose logs demo-seed`). Never run the demo profile on an instance holding
real data.

## Architecture at a glance

Two processes from one codebase: an **app** (API and SPA, the fast path of retrieval
and answering) and a **worker** (every slow job: extraction, verification,
reconciliation, the deletion saga, nightly consolidation and integrity sweeps),
connected by a transactional outbox and an idempotent job queue, so nothing is ingested
and silently unprocessed.

**Postgres is the source of truth; Qdrant is a rebuildable index.** Originals live in
MinIO under SSE-encrypted, tenant-scoped keys; Zitadel provides identity; Caddy
terminates TLS. Facts, not raw documents, are what gets stored and searched. One
instance is one tenant: isolation is a deployment boundary, not a row filter.

All model and embedding calls go through a single **gateway seam**, with adapters for
Mistral, any OpenAI-compatible endpoint, Anthropic, and a local Ollama
runtime, so inference can stay entirely on your own hardware. Which models an instance
runs is configured **in its own interface** and stored in its own database, never in a
configuration file the deployment ships. Every configuration is
published as its own entry in the [trust scores](eval/trust-scores/), so "works with
your model" is measured, not claimed.

Deeper reading: the [technical architecture](docs/cogeto-technical-architecture.md),
the [normative specification](docs/cogeto-specification.md), and the
[feature documentation](docs/features/).

## Links

- **Website:** [cogeto.eu](https://cogeto.eu), including the whitepaper
- **Documentation:** [`docs/`](docs/README.md)
- **Security and safety:** [`docs/security/`](docs/security/README.md), how the
  protections work and how to verify them
- **Run it locally:** [`docs/running-locally.md`](docs/running-locally.md)
- **Deploy it:** [`docs/deployment.md`](docs/deployment.md)

## License and trademark

The core is **AGPLv3** ([`LICENSE`](LICENSE)); commercial licenses (an AGPL exemption)
are available ([`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md)). The **Cogeto name and
logo are trademarks** and are *not* covered by the code license; see
[`TRADEMARK.md`](TRADEMARK.md) and [`assets/brand/README.md`](assets/brand/README.md).
Maintainership and IP: [`MAINTAINERS.md`](MAINTAINERS.md).

## Contributing

Contributions are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for the delivery
loop, running the tests and the eval harness, and the golden-set rules. Contributions
require accepting the [CLA](CLA.md) with a single PR comment; the reasoning is stated
there honestly. Security reports: [`SECURITY.md`](SECURITY.md).
