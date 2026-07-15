# Security Policy

Cogeto's product promise is verifiable trust — deletion receipts, integrity
sweeps, published audits. That only means something if security reports are
taken seriously. They are.

## Reporting a vulnerability

**Do not open a public issue.** Report privately, either way:

- **Email:** [info@mvt-solutions.com](mailto:info@mvt-solutions.com) with the
  subject line starting `SECURITY:`
- **GitHub:** [private vulnerability reporting](https://github.com/Cogeto/cogeto/security/advisories/new)
  on this repository

Include what you can: affected component/version, reproduction steps or a
proof of concept, and impact as you understand it. Reports in English or
Croatian are both fine.

## What to expect

- **Acknowledgement within 3 business days**, from a human.
- We triage, keep you informed of progress, and aim to ship a fix for
  confirmed vulnerabilities **within 90 days** (faster for anything actively
  dangerous). Coordinated disclosure: we ask you to hold public details until
  a fix is released; we'll credit you in the release notes unless you prefer
  otherwise. There is currently no bug bounty — we're honest about that — but
  reports are genuinely valued and acted on.

## Scope

**In scope**

- This repository: the application (app, worker, SPA), the compose stacks, the
  operator script, and the published release images
  (`cogeto/cogeto`, `cogeto/cogeto-edge`, `cogeto/cogeto-mail`).
- **The public demo sandbox is explicitly in scope** — it holds only fictional
  data and exists to be poked at. Please keep it usable for others (no
  volumetric/DoS testing).

**Out of scope**

- **Customer instances are out of scope without the instance owner's written
  authorization.** They are single-tenant deployments holding real personal
  data; testing them without authorization is an attack, not research.
- Volumetric denial-of-service, spam floods against inbound mail, and findings
  that require a compromised host or stolen credentials as a precondition.
- The marketing website (report it via the same address, but it is a separate,
  static codebase).

## Our own audits are public — deliberately

The repository's security and implementation-gap audits, including every
finding and its resolution, are published in [`docs/audits/`](docs/audits/).
Cogeto asks users to trust it with their working memory; the least it can do
is show its own homework. Reading those audits is also the fastest way to see
which classes of issues have already been considered and hardened.
