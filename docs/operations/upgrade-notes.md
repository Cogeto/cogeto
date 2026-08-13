# Upgrade notes

Release-specific things an operator has to know before or after an upgrade. The
general procedure is in [`../operator-runbook.md`](../operator-runbook.md) section 5;
this file carries only what one particular release changes about it.

Nothing here is optional reading for the releases it names. Where a release needs no
note, it has none.

---

## The embeddings model changes from the interface (V2.4 item 7.1, second half)

**What changes.** Changing the embeddings model is now a managed operation on the
**Models** page: a plan step states the corpus size, the token estimate, the
expected duration and the serving behaviour before anything is saved, and on
confirmation the instance re-embeds everything into a new vector collection while
the old one keeps serving, switching only at verified completion. Cancelling, a
failure, or a restart mid-rebuild leaves the previous configuration serving.
**No interface action can render the instance unstartable any more.**

**What you have to do: nothing.** Migration 0053 adds the index state row; existing
instances keep their collection and their model exactly.

**What changed for the shell.** `cogeto reindex` is a first-class subcommand now:
with no flags it rebuilds the index in place with the active model (the repair for
a restored backup whose index and configuration disagree), and with
`--provider LABEL --model MODEL` it moves the instance to a different embeddings
model using the same managed rebuild the interface runs, working even while the app
and worker refuse to start. The underlying command changed from
`docker compose exec worker npm run reindex` to

```sh
docker compose run --rm worker npm run reindex
```

because `run` starts a fresh container and therefore works while the services
crash-loop; the boot guard's message names both. The guard itself stays, as a net:
a mismatch manufactured outside the interface still refuses to serve wrong results,
with a message that states exactly what mismatched and the command that resolves it.

**Watching a rebuild.** The Models page shows live progress with a cancel button;
`GET /api/health` carries a `reindex` block while one is in flight, and the System
page's capabilities panel shows the same. A rebuild that exhausts the daily model
budget pauses and resumes by itself; one that keeps failing parks as failed with
the error shown, waiting for resume or cancel.

---

## Model and provider configuration lives in the database (V2.4 item 7.1)

**What changes.** Providers, models and their API keys are records an administrator
manages in the interface, under **Providers** and **Models** in the left rail. The
database is the only source of model configuration and the interface is the only
way to change it; there is no environment seed and no fallback. `.env` keeps
bootstrap only: database credentials, the instance master key, and instance
configuration.

An instance with **no provider configured is the normal first-run state**, not an
error: it boots, serves, health stays ok, the interface shows a banner pointing at
the Providers page, and queued work waits and drains once a provider is added,
without a restart.

**What you have to do.**

1. **Have `COGETO_MASTER_KEY` in `.env` before storing any provider API key.** It is
   what encrypts the keys stored in the database, and it stays in `.env` because a
   key that guards a database cannot live inside it. `cogeto install` generates one
   and `cogeto upgrade` backfills one if it is missing. By hand:

   ```sh
   openssl rand -base64 32
   ```

   An instance whose only endpoint is a self-hosted server with no authentication
   needs none, and the interface will tell you plainly if one is required.

   **It is data-bound, like `MINIO_KMS_SECRET_KEY`.** Never rotate it: rotating it
   makes every stored provider key unreadable, and the only recovery is re-entering
   them in the interface. Re-vault `.env` after the upgrade.

2. **Nothing else.** The old model variables (`COGETO_PROVIDER_*`,
   `COGETO_MODEL_PIPELINE` and its siblings, the per-provider key and base-URL
   variables, `COGETO_PROVIDER_PRESET`) no longer exist, and a stale one left in
   `.env` has no effect at all. There is no migration story to tell: no instance
   predating this scheme was ever deployed.

   What stays in `.env`, because it is a deployment fact rather than a model choice:
   the per-tier request timeouts (`COGETO_MODEL_TIMEOUT_*_MS`, with the legacy
   `COGETO_OLLAMA_TIMEOUT_*_MS` alias still honoured), the reasoning headroom
   (`COGETO_REASONING_HEADROOM`), the probe timeouts, the vision page caps, and the
   eval-harness-only grader override (`COGETO_PROVIDER_GRADER` /
   `COGETO_MODEL_GRADER`). The harness also reads its own `COGETO_MISTRAL_API_KEY`
   and `COGETO_PROVIDER_*` / `COGETO_MODEL_*` variables, because it runs in CI
   against no instance database; those readings are harness-only and touch nothing
   in a running instance.

**Changing the embeddings model is the managed rebuild** described in the previous
section: plan and confirm on the **Models** page, or from the shell with
`cogeto reindex --provider LABEL --model MODEL` (equivalently
`docker compose run --rm worker npm run reindex`). The boot guard that refuses to
serve a mixed embedding space stays, as a net for states manufactured outside the
interface.

**Rolling back.** The provider tables are additive (migration 0052), and the
database keeps the configuration across an image rollback: no release reads model
configuration from `.env`, so rolling images back changes nothing about which
models the instance runs.
