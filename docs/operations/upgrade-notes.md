# Upgrade notes

Release-specific things an operator has to know before or after an upgrade. The
general procedure is [`../operator-runbook.md`](../operator-runbook.md) section
6; this file carries only what one particular release changes about it, and a
release with nothing to say has no entry.

Nothing here is optional reading for the releases it names.

---

## Outstanding note: the first release carrying the managed provider

The next release adds the **managed provider** (migration 0064): on a hosted
plan, exactly one provider row per instance is reconciled at boot from a
platform-rendered configuration file (`COGETO_MANAGED_PROVIDER_FILE`) plus a
bootstrap key (`COGETO_MANAGED_PROVIDER_API_KEY`), and is read-only in the
interface. In full:
[`../features/models.md`](../features/models.md#the-managed-provider-hosted-provisioning).

**A self-managed instance is untouched.** With neither variable set, nothing
reconciles, nothing changes, and the interface remains the only place models
are configured; that byte-identity is a tested property. Do not set one of the
pair without the other: the boot then refuses, naming what is missing, which is
deliberate.

For platforms: both compose channels mount `./managed-provider` read-only next
to the compose file; render the JSON there and point the file variable at
`/managed-provider/managed-provider.json`. Rotate the key by re-rendering
`.env` and restarting. Never repoint the served embeddings model at a different
upstream model in place: the boot refuses it, and the honest path (a new served
name plus the managed rebuild) is in the feature document.

---

## Outstanding notes: the first release carrying spaces

The next release introduces spaces (migrations 0060 through 0063), fully
sealed partitions of the instance. A single-space instance behaves as before,
with two exceptions an operator or integrator must know BEFORE upgrading. In
full: [`../features/spaces.md`](../features/spaces.md).

**1. Machine tokens are refused until an administrator binds them to a
space.** This is a deliberate breaking change for API integrations. A machine
caller is any bearer token that resolves without a human profile (no email
claim): every Zitadel service-user token, and any token minted by a non-SPA
client without the email scope. Such a token must be bound to exactly one
space, there is no ambient default for machines, and a call that cannot
resolve a space is refused with 403. The refusal itself names the remedy:

```
PUT /api/spaces/machine-bindings/<service user id>   (administrator role)
```

with body `{"spaceId": "<space id>"}`. A space header that disagrees with the
binding is also refused, never honored. An integration that worked before the
upgrade returns 403 after it until the binding exists; nothing is lost, and
binding it restores the integration unchanged within its bound space.

**2. Pre-existing memories are invisible to VECTOR search until their index
payloads carry the space.** The vector gate now requires the space inside the
query, and vectors written before the upgrade do not carry it yet. The
Postgres arms (keyword, entity, temporal) still return everything, so this is
a partial recall dip, never a leak, and it is temporary: the nightly
integrity sweep (03:00 UTC) backfills the payloads, so the window closes on
its own within a day. To close it immediately, run the flagless

```
cogeto reindex
```

after the upgrade: it rebuilds every vector with its current payload, space
included. Fresh installs are unaffected.

---

Every note below is historical. The releases that carried them are at or below
the current release line, and no instance exists that predates it, so there is
no upgrade path any of them applies to. They stay as a record of what changed
and, more usefully, as pointers to where each subject is now documented in full.

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
