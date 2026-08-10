# Upgrade notes

Release-specific things an operator has to know before or after an upgrade. The
general procedure is in [`../operator-runbook.md`](../operator-runbook.md) section 5;
this file carries only what one particular release changes about it.

Nothing here is optional reading for the releases it names. Where a release needs no
note, it has none.

---

## Model and provider configuration moves into the database (V2.4 item 7.1)

**What changes.** Providers, models and their API keys stop being environment
variables and become records an administrator manages in the interface, under
**Providers** and **Models** in the left rail. `.env` keeps bootstrap only: database
credentials, the instance master key, and instance configuration.

**What you have to do: nothing, on the first start.** The existing environment values
are read once and written as the equivalent providers and assignments. The instance
runs the configuration it was running before: same providers, same models, same
endpoint, same configuration id, no tier reassigned. Log in and check
**Models** to see the four rows; the boot log states `source: database` once the seed
has happened.

**What you should do afterwards.**

1. **Set `COGETO_MASTER_KEY` if the instance has any provider API key.** It is what
   encrypts the keys stored in the database, and it stays in `.env` because a key that
   guards a database cannot live inside it. `cogeto upgrade` generates one for you if
   it is missing. By hand:

   ```sh
   openssl rand -base64 32
   ```

   An instance whose only endpoint is a self-hosted server with no authentication
   needs none, and the first start will tell you plainly if one is required.

   **It is data-bound, like `MINIO_KMS_SECRET_KEY`.** Rotating it makes every stored
   provider key unreadable, and the only recovery is re-entering them in the
   interface. Re-vault `.env` after the upgrade.

2. **Delete the model variables from `.env` after the first successful start.** They
   are ignored from that point: not merged, not a lower-priority fallback, ignored.
   Leaving them costs nothing but invites the belief that editing one does something.
   The variables that are now managed in the interface:

   ```
   COGETO_MISTRAL_API_KEY          COGETO_OPENAI_API_KEY      COGETO_ANTHROPIC_API_KEY
   COGETO_MISTRAL_MODEL_PIPELINE   COGETO_OPENAI_BASE_URL     COGETO_ANTHROPIC_BASE_URL
   COGETO_MISTRAL_MODEL_ANSWER     COGETO_OLLAMA_BASE_URL     COGETO_OLLAMA_API_KEY
   COGETO_MISTRAL_EMBED_MODEL      COGETO_PROVIDER_PRESET
   COGETO_PROVIDER_PIPELINE        COGETO_MODEL_PIPELINE
   COGETO_PROVIDER_ANSWER          COGETO_MODEL_ANSWER
   COGETO_PROVIDER_EMBEDDINGS      COGETO_MODEL_EMBEDDINGS
   COGETO_PROVIDER_VISION          COGETO_MODEL_VISION
   ```

   What stays in `.env`, because it is a deployment fact rather than a model choice:
   the per-tier request timeouts (`COGETO_MODEL_TIMEOUT_*`), the reasoning headroom
   and probe deadline, the vision page caps, and the eval-harness-only grader
   override.

**The embeddings model still cannot be changed from the interface.** V2.4 item 7.1 is
the configuration half; the managed rebuild of the vector index is the second half and
ships in the next release. Until then the embeddings row explains this and names the
interim path:

```sh
docker compose exec worker npm run reindex
```

That is unchanged from before this release, and the boot guard that refuses to serve a
mixed embedding space is unchanged too.

**Rolling back.** The provider tables are additive (migration 0052) and the previous
release ignores them, so rolling the images back leaves an instance reading its `.env`
again, which is why deleting the model variables is step 2 and not step 1. Delete
them once you are satisfied the upgrade holds.
