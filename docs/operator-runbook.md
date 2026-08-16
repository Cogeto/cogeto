# Cogeto operator runbook

The lifecycle of one customer instance on OVHcloud, from empty VM to steady
state. **Audience: the operator.** Operations are script-driven and
manual-by-design: the script does what it can, this runbook covers
everything around it. One instance = one customer = one VM (single-tenant).

The tool is [`scripts/operator/cogeto`](../scripts/operator/cogeto). Run
`cogeto --help` for the full command reference. Where the
script prints a value (DNS records, secrets, checklists), **copy from its
output**: this runbook tells you where those values go, not what they are.

Developer-facing notes on the script live in
[`docs/operations/operator-script.md`](operations/operator-script.md).

---

## 0. Before anything: what you need

- [ ] Access to the **OVHcloud control panel** (Public Cloud project + the DNS
 zone for the customer's domain, typically `cogeto.eu`).
- [ ] The instance's **app domain** agreed with the customer, e.g.
 `acme.cogeto.eu`.
- [ ] No model key is needed to install. After first login an administrator adds
 a provider in the interface (a key from any supported provider, or a
 self-hosted endpoint), and model features are off until then.
- [ ] An entry prepared in the **trial tracker** (section 8) and your **vault**
 ready to receive the instance secrets.
- [ ] Install the **latest published release**. The script resolves it itself
 (the newest GitHub release not flagged pre-release) and asks you to confirm
 it; `--version X.Y.Z` pins an older one, and retired releases are refused.

---

## 1. Provisioning the OVHcloud VM

1. **Create the instance**: OVHcloud panel → **Public Cloud** → your project →
 **Instances** → **Create an instance**.
 - **Model**: General Purpose **b3-8** (2 vCores, 8 GB RAM, 50 GB NVMe) is
 the minimum the script accepts (≥ 8 GB RAM, ≥ 2 CPUs, ≥ 30 GB free);
 **b3-16** is the comfortable default for a busy customer.
 - **Region**: an **EU region** (e.g. GRA or SBG): EU hosting is the
 product promise; do not deploy outside the EU.
 - **Image**: **Ubuntu 24.04 LTS** (22.04 is also supported by the script).
 - **SSH key**: add yours; you will log in as `ubuntu` and use `sudo`.
 - **Network**: a public IPv4 is required (default). No vRack needed.
2. **Note the public IPv4** shown on the instance page: the DNS records and
 the PTR all use it.
3. **Firewall**: the instance must accept inbound TCP **22** (SSH), **80**
 (ACME + redirect) and **443** (HTTPS). Port **25** is needed **only if the
 instance uses email capture**, which is now an opt-in capability (security
 audit 2.0, SEC-14): a fresh install runs no SMTP listener at all.
 - If you use the **OVH Network Firewall** on the IP (Public Cloud →
 **Network** → Public IPs → the IP → firewall): allow 22, 80 and 443, plus
 25 only after you enable email capture.
 - If `ufw` is active on the host, `cogeto install` opens 80/443 itself, and
 `cogeto features enable mail` opens 25 when you turn email capture on.
 - Nothing else should be open. The stack publishes only 80/443 (plus 25 with
 email capture enabled); Postgres/Qdrant/MinIO/Zitadel are internal-only by
 construction.
4. **DNS zone prerequisite**: confirm you can edit the DNS zone that owns the
 app domain (Web Cloud → **Domain names** → the domain → **DNS zone**). The
 actual records are added **after** install (the script prints them).

---

## 2. First install

1. SSH in and fetch the script:

 ```sh
 ssh ubuntu@<instance IP>
 curl -fsSL https://raw.githubusercontent.com/Cogeto/cogeto/main/scripts/operator/cogeto -o cogeto
 chmod +x cogeto
 ```

2. **Dry run first** (changes nothing, prints the whole plan and checklist):

 ```sh
 sudo ./cogeto install --check --domain acme.cogeto.eu --acme-email <your ops address>
 ```

3. **Install**:

 ```sh
 sudo ./cogeto install --domain acme.cogeto.eu --acme-email <your ops address>
 ```

 The script verifies OS/resources, installs Docker **and cosign** (every
 image this instance runs is signature-verified before it starts),
 installs **itself to
 `/usr/local/bin/cogeto`** (so `sudo cogeto status` works from anywhere
 afterwards), generates all secrets into `/srv/cogeto/.env` (mode 600),
 derives the inbound address (`capture@in.<domain>`), pulls the signed
 images, brings the stack up, and waits for health. It ends with
 the **WHAT YOU MUST DO NOW** checklist, everything below is that
 checklist, expanded with the OVH panel locations.

4. **Vault, immediately**: store `/srv/cogeto/.env` and the Zitadel admin
 login (`admin@<domain>` + `ZITADEL_ADMIN_PASSWORD` from `.env`) in your
 vault, and record the instance in the trial tracker (section 8).

### What the install provisions: the least-privilege data plane

This is the provisioning shape for every fresh install; nothing here needs
operator action beyond vaulting `.env`, but you should know what exists:

- **Postgres runs three application-facing identities**, all generated into
 `.env` by the install: `cogeto_app` (the app/worker runtime, DML only, no
 DDL, cannot reach the `zitadel` database), `cogeto_migrate` (owns the
 schema, used only by the migration job) and `zitadel_admin` (Zitadel's own
 bootstrap admin). The superuser credential (`POSTGRES_PASSWORD`) is
 break-glass only: no long-running service holds it.
- **MinIO runs a scoped application credential** (`COGETO_S3_ACCESS_KEY` /
 `COGETO_S3_SECRET_KEY`): object read/write/delete on the `cogeto` bucket
 and nothing else, no admin API. The root credential is used only by the
 bucket-provisioning init job.
- **The public `s3.<domain>` vhost only answers presigned downloads**
 (GET/HEAD on the bucket); everything else gets 403.
- **The Zitadel bootstrap PAT is short-lived and revoked**: minted with a
 14-day expiry, used once by the provisioning job, then revoked and blanked
 the moment provisioning succeeds. See "Changing the domain after install"
 below for the one flow that later needs a fresh one.
- **Rotatable without data impact** (`cogeto configure --regenerate NAME`):
 `COGETO_APP_DB_PASSWORD`, `COGETO_MIGRATE_DB_PASSWORD`,
 `ZITADEL_DB_ADMIN_PASSWORD`, `COGETO_S3_SECRET_KEY`, plus the previously
 rotatable `COGETO_MAIL_INTAKE_TOKEN` and `COGETO_QDRANT_API_KEY`. The
 data-bound secrets (`POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`,
 `MINIO_KMS_SECRET_KEY`, `ZITADEL_MASTERKEY`, `ZITADEL_DB_PASSWORD`)
 remain manual, backed-up procedures.

### Changing the domain after install (needs a fresh bootstrap PAT)

`cogeto configure --domain` re-runs the Zitadel provisioning job to update
the OIDC redirect URIs, and that job's bootstrap PAT was revoked after the
install (SEC-16). The script prints this in its checklist; the manual steps:

1. Log in to Zitadel as the admin, open **Users → Cogeto Bootstrap →
 Personal Access Tokens**, and create a new token (a short expiry is fine,
 it is needed once).
2. Write it into the machinekey volume and clear the recorded state:

 ```sh
 cd /srv/cogeto
 docker compose run --rm -T --entrypoint sh zitadel-init -c \
 'printf %s "<the token>" > /machinekey/pat.txt && rm -f /machinekey/bootstrap-state.json'
 docker compose up -d
 ```

3. The provisioning job re-runs with the new domain, then revokes and blanks
 the new token exactly as at install time.

### 2a. The DNS records (OVH panel)

The script prints the **exact records with real values**: copy them from its
output. In the OVH panel: **Web Cloud → Domain names → the domain →
DNS zone → Add an entry**:

| # | Type | Record (subdomain field) | Target | When |
| --- | --- | --- | --- | --- |
| 1 | A | `acme` (the app domain) | the instance IPv4 | always |
| 2 | A | `s3.acme` (presigned-download origin) | the instance IPv4 | always |
| 3 | A | `mail.acme` (the mail host) | the instance IPv4 | **only with email capture enabled** |
| 4 | MX | `in.acme` (the inbound subdomain) | priority `10`, target `mail.acme.cogeto.eu.` | **only with email capture enabled** |

**Records 3 and 4 apply only when the `mail` capability is on** (security
audit 2.0, SEC-14). Inbound SMTP is opt-in: on a fresh install no listener
runs, and the script's checklist omits these records entirely. Turn email
capture on with `sudo cogeto features enable mail`: it starts the receive-only
listener, opens 25/tcp in `ufw` and prints records 3 and 4 with the instance's
real values at that point. `cogeto features disable mail` stops the listener
and closes the port again.

Notes the script also prints (with email capture enabled):

- **PTR (reverse DNS)**: set the reverse of the instance IPv4 to
 `mail.<domain>`: Public Cloud → **Network** → **Public IPs** → the IPv4 →
 **⋯ → Edit the reverse**. Without a matching forward/reverse pair some
 sending servers soft-reject the instance.
- **SPF**: receiving needs none (Cogeto never sends). Only check that a
 strict SPF on the apex does not claim the `in.<domain>` subdomain.

### 2b. Knowing DNS has propagated

From your own machine (not the instance):

```sh
dig +short A acme.cogeto.eu # → the instance IP
dig +short A s3.acme.cogeto.eu # → the instance IP
# Only with email capture enabled:
dig +short MX in.acme.cogeto.eu # → 10 mail.acme.cogeto.eu.
dig +short -x <instance IP> # → mail.acme.cogeto.eu.
```

When the A record resolves, Caddy obtains the Let's Encrypt certificate
automatically within minutes, **no restart, no action**. Confirm with
`sudo ./cogeto status` on the instance: the TLS section flips from "not from a
public CA yet" to the Let's Encrypt certificate with its expiry, and the
verdict can go GREEN. OVH zone changes usually propagate in minutes; the zone
TTL is the upper bound.

### 2c. Inbound-mail hardening (STARTTLS + sender SPF)

**Skip this section entirely unless email capture is enabled**
(`cogeto features enable mail`). With it off there is no mail container and no
listening port to harden.

Two hardening topics for the internet-facing mail server. Neither needs an
action from you any more; both are here so you can verify them.

- **STARTTLS for inbound mail: nothing to do.** Your one action is the
 `mail.<domain>` A record (record 3 above), which
 `cogeto features enable mail` already printed. From there the certificate is
 obtained, propagated and renewed automatically, on every renewal, so there
 is no recurring chore and no expiry to diarise. How that works, end to end,
 is described once in
 [`operations/email-inbound.md`](operations/email-inbound.md#inbound-tls-starttls);
 you do not need it to operate the instance, only to debug it.

 **Verify** from your own machine, not the instance:

 ```sh
 openssl s_client -starttls smtp -connect mail.acme.cogeto.eu:25 -crlf </dev/null
 # → the certificate chain, and a 250-STARTTLS line in the EHLO response.
 ```

 Or on the instance, `sudo cogeto status` prints an "inbound mail TLS"
 section: whether STARTTLS is actually advertised and when the certificate
 expires. If it reports CLEARTEXT, the usual cause is that the
 `mail.<domain>` A record does not resolve here yet; check with
 `dig +short A mail.acme.cogeto.eu` and, if that is fine, read
 `sudo docker compose logs --tail 50 mail-tls-sync` in `/srv/cogeto`.

 **Using your own certificate instead** (an internal CA, or a wildcard you
 already hold) is supported as an override, with renewal then becoming your
 responsibility. The requirements are exact and one of them is a silent trap:
 [`operations/email-inbound.md`](operations/email-inbound.md#operator-supplied-certificates-an-override).

- **Sender SPF authentication (SEC-1).** Cogeto now captures a message for the
 registered user it claims to be from **only if the sending server passes SPF**
 for that sender's domain, so a spoofed `MAIL FROM` from an unauthorised host
 cannot inject memory into that user's account (a hard SPF `fail` is refused
 outright). No instance DNS change is needed for this; it protects
 automatically. Advise each **customer** that their own sending domain should
 publish an SPF record (most business domains already do) so their legitimate
 self-captured mail authenticates; mail they simply forward from a provider
 (Gmail, Microsoft 365) already passes SPF for that provider. To confirm a
 spoof is blocked, the acceptance test below sends an unauthenticated message
 and checks it is refused.

---

## 3. Verifying a new instance (acceptance checklist)

Run through **all** of this before handing the instance to the customer. Do it
as the admin user (`admin@<domain>`). For the email test you need one address
you control that is **registered on a user of this instance**, because capture
routes by sender: the registered address is captured for its own user with
nothing to configure, and an allowlist entry is only for mail arriving from
somewhere else.

- [ ] **HTTPS login**: `https://<domain>` serves a valid Let's Encrypt
 certificate and the login page; the admin can sign in and reach the
 dashboard. The nav footer shows the expected version.
- [ ] **Status green**: `sudo ./cogeto status` → `VERDICT: GREEN` (containers
 healthy, `/api/health` all ok, TLS valid, versions match).
- [ ] **Email lands** (sender-routed), *only if you enabled the `mail`
 capability; skip otherwise*: as the **customer
 user**, forward any short real message **from the address their user is
 registered with** to `capture@in.<domain>`: no configuration needed;
 within a minute or two it appears as a source and produces memories
 (Memories page). A **stranger's** mail must be refused (no source; the
 sender gets an SMTP 550; the refusal shows under "Recently refused"
 with its reason). Mail from the **admin account's** address is refused
 too: the operator login never captures.
- [ ] **Reply draft**: open the test email's source drawer → **Draft reply**
 → a pending draft appears in **Approvals**; approving it finalises a
 copy-ready draft (`.eml` / copy / mailto) and **sends nothing**.
- [ ] **Deletion receipt**: delete the test email source (source drawer →
 delete) → **Forgotten** shows a signed receipt that verifies (chain OK),
 counting the memories and objects it erased.
- [ ] **Passport export**: **Settings → Export my data · Memory Passport** →
 export completes and the `.zip` downloads (contains `manifest.json`,
 `manifest.json.sig`, `memories.json`, `receipts.json`; the manifest is
 stamped `passport_version 2.0`).
- [ ] **Status still green** after all of the above (the deletion sweep and
 queue stay clean): `sudo ./cogeto status`.

If any box fails, stop and see section 7 (troubleshooting), do not onboard
onto a yellow instance.

---

## 4. Onboarding the customer

1. **Create their user** in Zitadel: follow
 [`docs/operations/adding-users.md`](operations/adding-users.md) (Console at
 `https://<domain>/ui/console` → Users → **+ New**). **Use "Set initial
 password"** and hand it over out-of-band: never "Send an email
 invitation": the instance has no outbound SMTP, so invitations silently
 never arrive. Register the user with **the email address they will
 forward mail from**: that address routes their email capture. No app-side step: Cogeto provisions on first login. Roles are not
 needed in v1; the `admin` role is only for the operator's System view.
2. **First login together**: the customer signs in at `https://<domain>`,
 lands on an empty dashboard (empty states everywhere are correct).
3. **Default scope**: in **Settings**, set their default capture scope:
 **private** is the default and right for a single-user instance; explain
 that shared scope only matters if teammates are added later.
4. **Email capture setup** (sender-routed):
 - Show **Settings → Email capture**: their inbound address
 (`capture@in.<domain>`, copy button) and their **always-trusted own
 address**, anything they **forward** or **BCC** from it is captured
 for them automatically, nothing to configure.
 - The **allowlist** is for *external* senders: entries route mail from
 those senders (typically provider-side **auto-forward rules**) into
 *their* memory. Each user keeps their own list; whole domains work
 (`adriatic-foods.hr`, subdomains need their own entry). Refused mail
 shows under "Recently refused" with the reason and a one-click claim.
 - State plainly: Cogeto only ever receives what reaches the inbound
 address: never mailbox credentials, never the whole inbox. Captured
 email follows their **default scope** (step 3).
 - Send one real forwarded email together and watch it become memories.
5. **First-day orientation** (15 minutes, in this order):
 - **Capture** a few real notes (meeting outcomes, commitments, decisions).
 - **Ask in chat** about something just captured: answers cite sources;
 click a citation to open the memory and its provenance.
 - **Review**: where facts that **disagree with each other** wait for their
 judgement, and only those: everything else Cogeto settles on its own, and
 an uncertain fact says so on the fact itself rather than queueing.
 - **Dashboard**: commitments and follow-ups that still stand surface as
 open loops, due, overdue, or gone quiet, each opening the fact behind it.
 - **Forgotten**: delete something and show the signed receipt: deletion
 is provable, not promised.
 - **Time travel** and the **Memory Passport** (Settings): knowledge has
 history, and all of it is exportable. They can leave anytime.
6. Record onboarding date and trial dates in the tracker (section 8).

### 4b. Model configuration and local runtimes

Model configuration lives in the **interface**, not in `.env` and not in the
script: **Providers** (left rail) is where an administrator adds a provider
record and its API key (Mistral, OpenAI, Anthropic, or **Self-hosted** for any
OpenAI-compatible endpoint), and **Models** is where the four tiers (pipeline,
answer, embeddings, vision) are assigned. Changes apply **without a restart**,
and the Models page shows the published trust score for the exact configuration
in force, or says "not evaluated". A fresh instance with no provider is a
normal state: the interface banner points at Providers, and queued work waits
and drains once one is added. The full reference is
[`docs/features/models.md`](features/models.md).

To run tiers on a customer-owned local runtime (Ollama, llama.cpp, vLLM):

1. **On the runtime host**: install the runtime, then pull the chosen models,
 e.g. `ollama pull gemma3:12b` (generation) and `ollama pull bge-m3`
 (embeddings).
2. **Networking**: the compose containers must reach the runtime address, and
 this is where a local setup usually stumbles. `localhost` inside the app
 container is the container, never the VM, so a runtime on the VM itself is
 reached at the host's LAN address (or `host.docker.internal` where the
 platform provides it), never at `127.0.0.1`. For a WireGuard address the VM
 (the Docker **host**) must hold the wg route and forward traffic from the
 Docker bridge subnet, or the runtime must bind an address the bridge can
 reach. Verify **from inside a container** before configuring anything, from
 `/srv/cogeto`:

 ```sh
 sudo docker compose exec -T app \
 node -e "fetch('http://<addr>:11434/api/tags').then(r=>r.text()).then(console.log)"
 ```

 A list of models is the answer you want. A connection error here means the
 interface will fail the same way, and no provider record can fix it: repair
 the route first.
3. **Configure in the interface**: add a **Self-hosted** provider under
 Providers with the runtime's OpenAI-compatible URL (Ollama serves one; so do
 llama.cpp and vLLM), then assign the tiers under Models. No API key is
 needed for a runtime with no auth; saving an assignment probes the tier's
 real job, and a failed probe names the reason (unreachable, model not
 served, and so on).
4. **Changing the embeddings tier is a managed rebuild** (V2.4 item 7.1
 second half): do it from the Models page, which plans (facts, token
 estimate, duration, spend), asks for confirmation, re-embeds everything into
 a new index while the old one keeps serving, and switches atomically at
 completion. From the shell the same operation is `sudo cogeto reindex
 --provider <label> --model <model>`; the flagless `sudo cogeto reindex` (or
 `sudo docker compose run --rm worker npm run reindex`) is the in-place
 repair for an index/configuration mismatch. Progress prints done/total;
 every mode is safe to re-run if interrupted.
5. The per-tier request timeouts stay environment configuration
 (`COGETO_MODEL_TIMEOUT_ANSWER_MS` / `_PIPELINE_MS` and friends in
 `/srv/cogeto/.env`): local first-token latency is seconds and a large
 structured extraction can run minutes, so the defaults for self-hosted
 endpoints are already high.

Before recommending a local configuration, know the rule it is held to
([`docs/features/models.md`](features/models.md), "Parity-gated migration"): a
tier is recommended local only where it reaches eval parity per task and per
language against the hosted baseline. Where all-local misses parity, the mixed
posture (hosted generation over local embeddings) stays the recommendation.
The measurements are published per configuration in the trust scores, and the
Models page states plainly when the configuration in force has none.

### 4c. Optional capabilities: `cogeto features`

You never need to remember compose profiles: `sudo cogeto features` is the
one command for optional capabilities.

```
sudo cogeto features # list + live health
sudo cogeto features enable research # SearXNG on this instance; nothing external
sudo cogeto features disable research
```

**Five capabilities are switched here**: `redaction`, `research`, `mail`,
`demo` and `consoles`. **Four more are reported and not switched here**:
`models`, `reasoning`, `vision` and `connectors`. The script prints both
groups, because the list an operator reads has to match the list the instance
reports: seeing a capability in health and not in the script is how an
operator concludes something is broken when nothing is.

Where those four are decided:

| Capability | Decided by |
| --- | --- |
| `models` | the interface: Providers, then Models (section 4b) |
| `vision` | the interface: assign a vision model under Models. Unassigned is a complete answer, and the reading ladder stops at OCR |
| `reasoning` | nothing: it is a probed fact about the assigned answer model, on when that model returns its thinking in a separate field |
| `connectors` | the interface: Connections. Off until one is added |

Do not take the capability list from this page. Take it from
`sudo cogeto features`, which reads the live registry: this table names where
each capability comes from, and the instance names its state.

What enable/disable does: edits `/srv/cogeto/.env` idempotently (the
`COMPOSE_PROFILES` line plus the capability's own flags), re-applies the
stack (`docker compose up -d --remove-orphans`), waits for health, and prints
any operator TODOs. Notes per capability:

- **research**: fully local discovery (SearXNG, ~100-200 MB RAM, internal
 network only); nothing external to configure.
- **mail**: the receive-only inbound SMTP listener. Enabling it opens 25/tcp,
 prints the DNS records, and starts obtaining the inbound-TLS certificate
 automatically (section 2c).
- **redaction**: local PII pseudonymization in front of every model call.
 Enabling pulls and cosign-verifies the sidecar image, then sets the
 fail-closed posture: if the sidecar is unreachable, model calls FAIL rather
 than sending plaintext. Two things to decide first: it holds 0.7-1 GB of
 RAM, and because vectors are then built from pseudonymized text it is an
 instance-lifetime choice (switching later means a reindex). Disabling
 requires typing `disable redaction`: with it off, model calls send plaintext
 to the provider. Everything else about it, including what it does not cover,
 is stated once in
 [`security/data-sovereignty-and-redaction.md`](security/data-sovereignty-and-redaction.md).
- **demo**: REFUSED on a production instance, loudly, and its seed image is
 never published, so the deploy channel refuses it twice over. Never enable
 it beside real data.
- **consoles**: dev-only; its edge image is never published, so `enable
 consoles` on a customer instance is refused with that reason.

Health is honest: an enabled capability whose service is down shows
**UNREACHABLE** here, in System, and degrades `/api/health` within ~30
seconds (20 s registry cache + the panel's 10 s poll). The two nightly jobs
(dreaming 03:30, sweep 03:00 UTC) report last run and go **overdue** after 26
hours without a successful run (`COGETO_JOBS_OVERDUE_HOURS`).

### 4d. Erasing a departed user's data

When someone leaves, deactivating them in the Zitadel console ends their access
and **deletes nothing**. That is deliberate. Deciding what happens to their
material is a separate act, and this is how you carry it out.

**What it does, in one sentence:** erases every source the departed user owned
**privately**, through the ordinary deletion saga, producing one signed
deletion receipt per source; **shared material always stays**.

**Before you start**

- [ ] You have the departed user's **user id**, not their email. It is the
 Zitadel subject id, and it is what `actor` shows as `user:<id>` throughout
 the audit trail. The Console shows it on the user's page.
- [ ] You hold the **admin** role. This is administrative only.
- [ ] You have their **replacement's** agreement on what may go, if any of the
 material is work the team still needs. Anything shared is kept for you;
 anything private is not recoverable afterwards.
- [ ] You are on a **backed-up** instance with a rehearsed restore (§5). This
 is irreversible.

**Step 1: see what would happen.** Read-only, safe to repeat.

```sh
curl -sS https://<domain>/api/admin/erasure/<user-id> \
 -H "Authorization: Bearer $TOKEN" | jq
```

It answers with `toEraseCount`, `retainedSharedCount`, and a `byType`
breakdown. Read the `note` it returns: the plan counts sources whose OWN scope
is shared, and a private source is also retained when any fact derived from it
is shared, which the plan cannot count without enumerating every derived
memory. The completed run reports those separately.

**Step 2: request the erasure.** The confirmation must repeat the same user id;
a mismatch is refused, and so is erasing yourself.

```sh
curl -sS -X POST https://<domain>/api/admin/erasure/<user-id> \
 -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
 -d '{"confirmUserId":"<user-id>"}' | jq
```

The request is audited (`user.erasure_requested`, naming you and the subject)
and queued; the work runs in the worker, one saga transaction per source.

**Step 3: confirm it completed.** In **Audit** (admin only), the
`user.erased` entry carries the final counts: `erased`, `receipts`,
`retained`, `retainedSharedSource`, `retainedSharedFact`, `failed`. In
**Forgotten**, each erased source has its own signed receipt and the chain
still verifies.

- [ ] `failed` is 0. A non-zero count names sources that could not be erased,
 usually because something else removed them first; re-running the same
 request is safe and erases whatever is left.
- [ ] The receipt chain verifies (Forgotten → chain status).
- [ ] Record the erasure and its date in the customer's tracker.

**What it deliberately keeps, and what to do about it**

- **Shared sources.** Reported as `shared_source`. Kept by the rule: a
 colleague's shared knowledge does not disappear because that colleague left.
- **A private source holding at least one shared fact.** Reported as
 `shared_derived_fact`. The saga deletes by provenance, so erasing that source
 would take the shared fact with it; the whole source is kept instead. This
 means some of the departed user's private text can survive inside a retained
 source. If a specific one must go, the administrator decides that
 individually: change the shared fact's scope or delete it, then re-run the
 erasure, which will then take the source.

Re-running is always safe: it erases what is left and keeps what it kept.

---

## 5. Backups and restore

Backups use **OVHcloud's own capability**, configured in the panel: no Cogeto
backup scripts, by design. `./cogeto backup-info` prints this checklist on the
instance.

### 5a. Enable (once per instance)

- [ ] Public Cloud → **Instances** → the instance → **⋯ → Create a backup /
 Automated backup**: enable **daily** snapshots, retention **≥ 7 days**,
 scheduled **outside 03:00 to 04:00 UTC** (the nightly Cogeto jobs' window).
- [ ] Record in the tracker: backup enabled (date), schedule hour.
- [ ] The instance `.env` is **also** in your vault (section 2.4): the
 snapshot protects the box; the vault protects you if the box is gone.

### 5b. What the backup covers (and what it need not)

The snapshot images the whole disk, which includes every Docker volume and
`/srv/cogeto`. What actually matters:

| Data | Where | Must be restorable? |
| --- | --- | --- |
| **Postgres** (memories, receipts, audit: the source of truth) | `pg-data` volume | **Yes** |
| **MinIO** (original files, email raws, SSE-encrypted) | `minio-data` volume | **Yes** |
| **Receipt-signing keypair** | `instance-keys` volume (exists nowhere else) | **Yes**: without it the receipt chain cannot continue |
| Instance config + secrets | `/srv/cogeto/.env` (+ vault copy) | **Yes** |
| Zitadel (users) + its bootstrap PAT | Postgres + `zitadel-machinekey` volume | Yes (rides along) |
| **Qdrant** (vector index) | `qdrant-data` volume | **No: rebuildable**: `reindex` reconstructs it from Postgres (spec §4.2) |
| Caddy certificates | `caddy-data` volume | No: reissued automatically |

### 5c. Restore procedure: **rehearsed, not assumed**

Rehearse this **once per customer** shortly after onboarding, and record the
rehearsal date in the tracker. A backup you have never restored is a hope, not
a backup.

1. **Restore the snapshot to a new instance**: Public Cloud → **Instances** →
 **Create an instance** → in the image step choose **Backups** and pick the
 snapshot (same region, same or larger flavor). Boot it; note its **new
 public IPv4**.
2. SSH in. The full state is on disk (`/srv/cogeto`, Docker volumes). Bring
 the stack up and check:

 ```sh
 cd /srv/cogeto && sudo docker compose up -d
 sudo ./cogeto status
 ```

 Expect: containers healthy; TLS **not** green yet (DNS still points at the
 old IP).

3. **Rebuild the vector index** (Qdrant state is whatever the snapshot
 caught; the source of truth is Postgres, reindex reconciles them):

 ```sh
 sudo cogeto reindex
 ```

 (equivalently `cd /srv/cogeto && sudo docker compose run --rm worker
 npm run reindex`; `run` works even while app and worker refuse to start
 on the mismatch). It exits nonzero if the rebuilt index does not match
 the database, treat that as a failed restore.

4. **Repoint DNS**: point **every record you created in section 2a** at the
 new IPv4. Which records exist depends on this instance:
 - **Always**: the app domain's A record, and the `s3.<domain>` A record.
 - **Only if email capture is enabled** (`sudo cogeto features` says whether
 it is): the `mail.<domain>` A record. The MX record itself names a
 hostname, not an address, so it does not change; the A record it points at
 does. Also set the **PTR** of the new IP to `mail.<domain>` and retire the
 old instance's PTR.

 There is no fixed record count: an instance without email capture has two
 records here, one with it has three plus the PTR.
5. **Verify like a new instance**: run the section 3 acceptance checklist
 (login, forwarded email lands, a **new** deletion produces a receipt and
 the chain still verifies: this proves the signing keypair survived,
 Passport export, status GREEN).
6. Decommission the failed instance (Public Cloud → Instances → delete) once
 the customer confirms normal service.

For the **rehearsal**, do steps 1 to 3 and 5's spot checks against the rehearsal
copy **without** step 4 (leave DNS alone, check via
`curl -k --resolve <domain>:443:<new IP> https://<domain>/api/health/live`),
then delete the rehearsal instance.

---

## 6. Upgrades and rollback

1. Read the release notes for the target version
 (github.com/Cogeto/cogeto/releases), they state when a release changes
 the embedding model or needs anything beyond the standard flow. Releases
 flagged "pre-release" there are retired: the script refuses them.
2. **Take a fresh backup first** (section 5): the script demands a typed
 `BACKED-UP` acknowledgment before touching anything, because migrations
 are forward-only and the only full rollback is the backup restore.
3. **Re-download the script before every upgrade.** The copy on the instance
 is the one that installed it, and it cannot update itself: `install_self`
 copies the *running* file to `/usr/local/bin/cogeto`. When a release adds a
 credential the new compose requires, only the new script knows to backfill
 it, so the old one fetches the new compose and then dies on `docker compose
 pull` with "required variable is missing". It fails loudly and changes no
 data, but re-fetching first avoids the detour:

 ```sh
 curl -fsSL https://raw.githubusercontent.com/Cogeto/cogeto/main/scripts/operator/cogeto -o cogeto
 chmod +x cogeto
 ```

4. On the instance:

 ```sh
 sudo ./cogeto upgrade # → latest published release (shown + confirmed)
 sudo ./cogeto upgrade 1.7.2 # → a specific published release
 ```

 The script shows current → target, asks for a **typed confirmation**,
 pulls the signed images (refusing unpublished tags), re-runs migrations,
 restarts the stack, health-checks, and **detects itself** whether stored
 memories were embedded with a different model than configured, if so it
 offers **reindex** (typed `REINDEX` confirmation; it re-embeds via the
 model API, so it costs API calls). Say yes when it asks; there is no
 separate bookkeeping to do. An upgrade also **backfills any secrets a
 newer compose requires**, generating what is missing and never touching
 what is set, and the database roles converge on the next start: re-vault
 `.env` after an upgrade that prints new secret names. **Check
 [`operations/upgrade-notes.md`](operations/upgrade-notes.md) for the target
 release**: it carries only what one particular release changes about this
 procedure, and a release with nothing to say has no entry.

5. **Verify after**: `sudo ./cogeto status` is GREEN and prints the running
 `version`, which is the authoritative check. Log in as well and confirm the
 version at the bottom of the sidebar agrees. Expect a short app/worker
 restart blip during the upgrade,
 nothing more. Image signatures were already verified during the upgrade
 (cosign, mandatory).
6. **Rollback** (the script prints this too): `sudo ./cogeto upgrade
 <previous version>` with the typed `ROLLBACK` confirmation. Know what it
 does and does not do: it rolls the **images** back; **database migrations
 are forward-only** and stay. If the newer schema broke the older app, the
 real rollback is a **backup restore** (section 5c), which is why the
 rehearsal matters.
7. Record the upgrade (version, date, reindex yes/no) in the tracker.

### 6a. Clearing duplicate documents (optional maintenance)

Uploading the same file twice resolves to the document already held, so an
instance does not accumulate duplicates by ordinary use. If one somehow holds
copies of the same bytes as separate sources, this command finds them and
removes all but one **through the deletion saga**, so each removal leaves a
signed receipt like any other deletion.

It is **optional and never required by a migration**. Nothing breaks if it is
never run: the duplicates cost storage, some spend already paid, and a noisier
Sources list.

```sh
docker compose run --rm worker \
 node project/src/dist/entrypoints/dedupe-file-sources.js
```

**It changes nothing without `--apply`.** The default run prints the plan: each
group of identical bytes, how many facts each copy carries, how many stored
answers cite each copy, and which one it would keep. Read it before applying.

Which copy survives is not obvious, so the command decides rather than
assuming. The copy stored answers **cite** wins first, then the copy with the
**most facts**, then the oldest. The oldest is deliberately not the rule:
extraction is not bit-stable, so two copies of the same bytes can hold
different numbers of facts, and a copy whose pipeline failed holds none at
all.

A group is **held back** when removing a copy would break a stored answer.
Deleting a memory redacts every answer citing it, replacing that answer with a
line saying its source is gone, and when both copies are cited no choice of
survivor avoids it. Those groups are listed and left alone.

To act on a held-back group, **name the copy to keep**, using the twelve
characters the report prints:

```sh
docker compose run --rm worker \
 node project/src/dist/entrypoints/dedupe-file-sources.js \
 --keep 1656081e76a8 --apply
```

That is the decision the hold-back was asking for, so the group runs without
any blanket flag, and the report still states how many answers it will cost.
Repeat `--keep` once per group. A value matching two copies is refused rather
than guessed. `--allow-redaction` remains the blunt alternative: it accepts the
tool's own choice of survivor everywhere, which is rarely what you want for a
group it just said it could not decide well.

Running it again after applying finds nothing and exits 0.

---

## 7. Troubleshooting

Start every investigation the same way:

```sh
sudo ./cogeto status
```

It reports per-container health, the app's aggregate health (Postgres, Qdrant,
MinIO + encryption, migrations, **queue depth and dead-letter count**, the
deletion-sweep verdict, model gateway, mail listener), the served TLS
certificate, disk, and version drift, and it only says GREEN when everything
is actually working. The same aggregate view lives in the dashboard's
**System** panel (admin role), including the **dead-letter** list of jobs that
exhausted retries: a non-zero dead-letter count means work was lost and
always deserves a look.

Deeper logs, when needed:

```sh
cd /srv/cogeto
sudo docker compose ps
sudo docker compose logs --tail 200 app # or: worker, mail, caddy, zitadel
```

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Browser can't reach the domain / certificate warning; status says "not from a public CA yet" | DNS not propagated (or pointing at the wrong IP) | Check section 2b `dig` commands. Fix the A record in the OVH zone; Caddy retries ACME automatically once it resolves: no restart. |
| TLS still not issued though DNS resolves | Port 80 or 443 blocked (OVH Network Firewall), or a stale old A record | Allow 80+443 on the IP's firewall; `sudo docker compose logs caddy` shows the ACME errors verbatim. |
| Forwarded mail never arrives | In order of frequency: sent from an address that is neither the user's **registered address** nor on their **allowlist**; MX record wrong/missing; TCP 25 blocked; wrong recipient address | Check **Settings → Email capture → Recently refused** first (a refusal row = SMTP and Haraka are fine: the reason is shown; forward from the registered address, or claim the external sender in one click). Note the **admin account never captures**. Then `dig +short MX in.<domain>`; then confirm port 25 open (firewall) and `sudo docker compose logs mail`. Recipient must be exactly `capture@in.<domain>`. |
| Mail accepted at SMTP but no memories appear | Pipeline/dead-letter problem | `sudo ./cogeto status` queue line; dashboard System → dead-letter for the failed job and its error; `sudo docker compose logs worker`. |
| Chat/extraction fail with a model error | No provider configured yet (the designed first-run state), or an invalid provider key | Add or fix the provider key under **Providers** in the interface (no restart needed). |
| A local runtime shows unreachable (Providers page, gateway health) | Runtime down, or the container cannot route to the address (WireGuard/bridge) | Check the runtime is up (`curl http://<addr>:11434/api/tags` from the VM), then from inside a container (section 4b step 2); fix the runtime URL on the provider record (Providers page, probe it there) or the host route. |
| A local model probe fails with "model not served" | Model never pulled on the runtime host | Run the exact `ollama pull <model>` command the probe error names on the runtime host, then re-probe on the Providers page. |
| Local chat/extraction times out | Model too large for the hardware, or first-load latency | Raise `COGETO_MODEL_TIMEOUT_ANSWER_MS` / `_PIPELINE_MS` (defaults 300000) or use a smaller model; the first call after idle loads the model into memory. |
| App and worker refuse to start, naming an embedding-space mismatch | Stored vectors were made with a different model than the one configured (a restored backup, a direct database edit) | `sudo cogeto reindex` re-embeds from Postgres and repairs it; it works while the services crash-loop, because it runs a fresh container rather than attaching to one. The error names the same command. |
| Status: "running image differs from configured" | An upgrade or restart did not complete | `cd /srv/cogeto && sudo docker compose up -d`, re-run status; if it persists, re-run `sudo ./cogeto upgrade <configured version>`. |
| A container is `unhealthy`/restarting | Varies: read its logs | `sudo docker compose logs --tail 200 <service>`. Disk-full is the classic silent killer: status prints `df`; volumes live under `/var/lib/docker`. |
| Deletion-sweep alert / receipt chain not green | Integrity finding: the product's core promise | Do not improvise. Read the alert in System, capture logs, and escalate to the owner before touching data. |
| Locked out of admin | Password is `ZITADEL_ADMIN_PASSWORD` in `/srv/cogeto/.env` (vault copy) | Username `admin@<domain>` at the instance login. |

---

## 8. Manual trial tracking

Trials are tracked by hand until client volume justifies automation. Keep
**one record per instance** wherever you keep operator records (a spreadsheet
is fine). Fields: this exact set, so nothing lives only in your head:

| Field | Example |
| --- | --- |
| Customer + contact | Adriatic Foods: Ana Kovač, ana@… |
| App domain | `acme.cogeto.eu` |
| Inbound address | `capture@in.acme.cogeto.eu` |
| OVH instance name / region / flavor | `cogeto-acme` / GRA / b3-8 |
| Public IPv4 | … |
| Installed (date, by whom) / current version | 2026-07-20, IG / 1.7.2 |
| Trial start / trial end / decision | 2026-07-21 / 2026-08-18 /: |
| Backup enabled (date, schedule hour) | 2026-07-20, 22:00 UTC |
| **Restore rehearsed (date)** | 2026-07-22 |
| Last upgrade (version, date, reindex?) | |
| Vault entry | vault path/reference for `.env` + admin login |
| Notes | anything a future you needs |

Review the tracker weekly: trials nearing their end, instances never
rehearsed, versions falling behind.

---

## The lifecycle at a glance

```
provision VM (§1) → install + DNS + vault (§2) → acceptance checklist (§3)
→ onboard customer (§4) → enable backup + rehearse restore (§5)
→ steady state: upgrades (§6), status checks (§7), tracker reviews (§8)
→ on departure: erase the leaver's private material (§4d)
```
