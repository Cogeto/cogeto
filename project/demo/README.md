# Ana sandbox (`--profile demo`)

The public sandbox persona — the single artifact that appears in every pitch,
launch post, and partner email (§B.9, scope §8.4). Governing decision:
[`docs/decisions/0022-ana-sandbox-rulings.md`](../../docs/decisions/0022-ana-sandbox-rulings.md).

> ⚠️ **SECURITY — read before deploying (decision 0022 ruling 1).**
> The demo instance publishes a working Zitadel access token to anyone who loads
> the page (the pre-authenticated demo Principal). This is acceptable **only**
> because the instance holds **no real data** and is disposable.
> **The demo profile must NEVER share infrastructure (Postgres / Qdrant / MinIO /
> Zitadel) with a customer instance.** A leaked demo token must be able to reach
> nothing but fictional data. A production instance refuses to boot the demo seed
> (`assertDemoAllowed`).

## What's here

| Path | What it is |
|---|---|
| `seed/corpus.json` | The authored fictional world — ~31 first-person notes (en + hr) fed through the real API. Format: `seed/corpus.schema.md`. |
| `assets/adriatic-foods-consulting-agreement.pdf` | The uploaded document — the deletion-receipt demo object. Regenerate with `assets/build-agreement.mjs`. |

The seed/reset **code** lives in `project/src/entrypoints/demo/` (composition
root); this directory holds only the authored data.

## Running it

```bash
# Bring up the full stack in demo mode (seeds on a healthy app; ~a few minutes).
# Needs a Mistral key (COGETO_MISTRAL_API_KEY) — the seed runs the real pipeline.
docker compose --profile demo up --build

# Same, but also enable the worker's scheduled reset:
COGETO_DEMO_MODE=1 docker compose --profile demo up --build

# Re-seed a running instance from scratch (tears down demo data, re-seeds):
npm run demo:reset
```

With `COGETO_DEMO_MODE=1`, a demo instance re-seeds itself on a schedule (default
every 6 hours, `COGETO_DEMO_RESET_CRON`) — demo instances only, never a customer
instance.

## The three demo moments (the script)

1. **Ask what Ana promised Marko.** Chat → "What did Ana promise Marko?" → a
   cited answer about the revised Atlas proposal, conditional on Marko confirming
   the Q3 budget.
2. **Resolve the contradiction in Review.** The Atlas go-live is recorded as both
   September 1 and October 1 — resolve it live and watch the memory settle.
3. **Delete Ana's contract and watch the receipt.** Delete the Adriatic Foods
   consulting agreement and watch the deletion receipt confirm — hash-chained,
   signed, exportable. This is the money moment.

Everything is fictional (decision 0022 ruling 3).
