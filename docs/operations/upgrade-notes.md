# Upgrade notes

Release-specific things an operator has to know before or after an upgrade. The
general procedure is [`../operator-runbook.md`](../operator-runbook.md) section
6; this file carries only what one particular release changes about it, and a
release with nothing to say has no entry.

Nothing here is optional reading for the releases it names.

---

## Outstanding notes: none

Every note below is historical. The releases that carried them are at or below
the current release line, and no instance exists that predates it, so there is
no upgrade path any of them applies to. They stay as a record of what changed
and, more usefully, as pointers to where each subject is now documented in full.

An operator installing or upgrading today needs nothing from this file.

---

## Historical record

**The deploy channel gained redaction and automatic mail TLS** (issues
#565 to #568). Local PII redaction became available on a customer instance
(published signed image, the profile in the customer compose, the three
`REDACTION_*` variables reaching both processes); inbound-mail STARTTLS became
automatic, replacing a manual certificate-copy procedure that could never have
worked; and the Ollama-era `COGETO_OLLAMA_TIMEOUT_*_MS` alias was retired in
favour of `COGETO_MODEL_TIMEOUT_*_MS`, which the customer compose now passes.

- Redaction, in full:
  [`../security/data-sovereignty-and-redaction.md`](../security/data-sovereignty-and-redaction.md).
- Inbound-mail TLS, in full: [`email-inbound.md`](email-inbound.md#inbound-tls-starttls),
  including the [operator-supplied-certificate override](email-inbound.md#operator-supplied-certificates-an-override).
- The timeout names, and every other environment variable:
  [`../../.env.example`](../../.env.example).

**Model and provider configuration moved into the database** (V2.4 item 7.1).
Providers, models and their API keys became records an administrator manages in
the interface, under **Providers** and **Models**. The database is the only
source of model configuration and the interface the only writer: there is no
environment seed and no fallback, and a stale model variable left in `.env` has
no effect at all. An instance with no provider configured is the normal
first-run state.

The one thing that lives in `.env` and matters: **`COGETO_MASTER_KEY`**, which
encrypts the stored provider keys and stays outside the database because a key
that guards a database cannot live inside it. `cogeto install` generates one and
`cogeto upgrade` backfills one if it is missing. It is **data-bound**: rotating
it makes every stored provider key unreadable, with no recovery but re-entry.

- In full: [`../features/models.md`](../features/models.md).

**The embeddings model became changeable from the interface** (V2.4 item 7.1,
second half). Changing it is a managed rebuild: plan and confirm on the Models
page, re-embed into a new collection while the old one keeps serving, switch
only at verified completion. From the shell the same operation is
`cogeto reindex --provider LABEL --model MODEL`, and the flagless
`cogeto reindex` rebuilds the active collection in place. Both run
`docker compose run --rm worker`, never `exec`, so they work while app and
worker crash-loop, which is exactly when the repair is needed.

- In full: [`../features/models.md`](../features/models.md), and the operator
  path in [`../operator-runbook.md`](../operator-runbook.md) sections 4b and 5c.
