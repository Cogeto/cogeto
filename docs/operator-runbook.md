# Cogeto operator runbook

The lifecycle of one customer instance on OVHcloud, from empty VM to steady
state. **Audience: the operator.** Operations are script-driven and
manual-by-design (roadmap D3): the script does what it can, this runbook covers
everything around it. One instance = one customer = one VM (single-tenant,
decision 0019).

The tool is [`scripts/operator/cogeto`](../scripts/operator/cogeto) (Unit A,
decision 0030). Run `cogeto --help` for the full command reference. Where the
script prints a value (DNS records, secrets, checklists), **copy from its
output** — this runbook tells you where those values go, not what they are.

Developer-facing notes on the script live in
[`docs/notes/operator-script.md`](notes/operator-script.md).

---

## 0. Before anything: what you need

- [ ] Access to the **OVHcloud control panel** (Public Cloud project + the DNS
      zone for the customer's domain, typically `cogeto.eu`).
- [ ] The instance's **app domain** agreed with the customer, e.g.
      `acme.cogeto.eu`.
- [ ] A **Mistral API key** for the instance (console.mistral.ai) — the stack
      runs without one, but model features are off until it is set.
- [ ] An entry prepared in the **trial tracker** (section 8) and your **vault**
      ready to receive the instance secrets.
- [ ] The oldest installable release is **0.9.0** — earlier tags do not publish
      the edge/mail images.

---

## 1. Provisioning the OVHcloud VM

1. **Create the instance**: OVHcloud panel → **Public Cloud** → your project →
   **Instances** → **Create an instance**.
   - **Model**: General Purpose **b3-8** (2 vCores, 8 GB RAM, 50 GB NVMe) is
     the minimum the script accepts (≥ 8 GB RAM, ≥ 2 CPUs, ≥ 30 GB free);
     **b3-16** is the comfortable default for a busy customer.
   - **Region**: an **EU region** (e.g. GRA or SBG) — EU hosting is the
     product promise; do not deploy outside the EU.
   - **Image**: **Ubuntu 24.04 LTS** (22.04 is also supported by the script).
   - **SSH key**: add yours; you will log in as `ubuntu` and use `sudo`.
   - **Network**: a public IPv4 is required (default). No vRack needed.
2. **Note the public IPv4** shown on the instance page — the DNS records and
   the PTR all use it.
3. **Firewall**: the instance must accept inbound TCP **22** (SSH), **80**
   (ACME + redirect), **443** (HTTPS), and **25** (inbound mail).
   - If you use the **OVH Network Firewall** on the IP (Public Cloud →
     **Network** → Public IPs → the IP → firewall): allow those four ports.
   - If `ufw` is active on the host, `cogeto install` opens 80/443/25 itself.
   - Nothing else should be open. The stack publishes only 80/443/25;
     Postgres/Qdrant/MinIO/Zitadel are internal-only by construction.
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

3. **Install** (add the model key now if you have it):

   ```sh
   sudo ./cogeto install --domain acme.cogeto.eu --acme-email <your ops address> --mistral-key <key>
   ```

   The script verifies OS/resources, installs Docker **and cosign** (all
   three image signatures are verified), installs **itself to
   `/usr/local/bin/cogeto`** (so `sudo cogeto status` works from anywhere
   afterwards), generates all secrets into `/srv/cogeto/.env` (mode 600),
   derives the inbound address (`capture@in.<domain>`), pulls the three
   signed images, brings the stack up, and waits for health. It ends with
   the **WHAT YOU MUST DO NOW** checklist — everything below is that
   checklist, expanded with the OVH panel locations.

4. **Vault, immediately**: store `/srv/cogeto/.env` and the Zitadel admin
   login (`admin@<domain>` + `ZITADEL_ADMIN_PASSWORD` from `.env`) in your
   vault, and record the instance in the trial tracker (section 8).

### 2a. The DNS records (OVH panel)

The script prints the **exact four records with real values** — copy them from
its output. In the OVH panel: **Web Cloud → Domain names → the domain →
DNS zone → Add an entry**:

| # | Type | Record (subdomain field) | Target |
| --- | --- | --- | --- |
| 1 | A | `acme` (the app domain) | the instance IPv4 |
| 2 | A | `s3.acme` (presigned-download origin) | the instance IPv4 |
| 3 | A | `mail.acme` (the mail host) | the instance IPv4 |
| 4 | MX | `in.acme` (the inbound subdomain) | priority `10`, target `mail.acme.cogeto.eu.` |

Notes the script also prints:

- **PTR (reverse DNS)** — set the reverse of the instance IPv4 to
  `mail.<domain>`: Public Cloud → **Network** → **Public IPs** → the IPv4 →
  **⋯ → Edit the reverse**. Without a matching forward/reverse pair some
  sending servers soft-reject the instance.
- **SPF** — receiving needs none (Cogeto never sends). Only check that a
  strict SPF on the apex does not claim the `in.<domain>` subdomain.

### 2b. Knowing DNS has propagated

From your own machine (not the instance):

```sh
dig +short A acme.cogeto.eu          # → the instance IP
dig +short A s3.acme.cogeto.eu       # → the instance IP
dig +short MX in.acme.cogeto.eu      # → 10 mail.acme.cogeto.eu.
dig +short -x <instance IP>          # → mail.acme.cogeto.eu.
```

When the A record resolves, Caddy obtains the Let's Encrypt certificate
automatically within minutes — **no restart, no action**. Confirm with
`sudo ./cogeto status` on the instance: the TLS section flips from "not from a
public CA yet" to the Let's Encrypt certificate with its expiry, and the
verdict can go GREEN. OVH zone changes usually propagate in minutes; the zone
TTL is the upper bound.

### 2c. Inbound-mail hardening (STARTTLS + sender SPF)

Two hardening steps for the internet-facing mail server. Both are safe to do
after the instance is up.

- **STARTTLS for inbound mail (GAP-2).** The mail container advertises STARTTLS
  only when a certificate is present in its `mail-tls` volume. Copy the
  Let's Encrypt certificate Caddy already obtained for the **mail host**
  (`mail.<domain>`) into that volume as `cert.pem` + `key.pem`, then restart the
  mail container. On the instance:

  ```sh
  DOMAIN=mail.acme.cogeto.eu   # the mail host (record 3 above)
  CERTDIR=$(sudo docker volume inspect --format '{{ .Mountpoint }}' cogeto_caddy-data)/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$DOMAIN
  TLSDIR=$(sudo docker volume inspect --format '{{ .Mountpoint }}' cogeto_mail-tls)
  sudo cp "$CERTDIR/$DOMAIN.crt" "$TLSDIR/cert.pem"
  sudo cp "$CERTDIR/$DOMAIN.key" "$TLSDIR/key.pem"
  sudo docker compose -f docker-compose.deploy.yml restart mail
  # Verify: the mail log prints "STARTTLS enabled", and from your own machine:
  #   openssl s_client -starttls smtp -connect mail.acme.cogeto.eu:25 -crlf
  # should show the certificate and a 250-STARTTLS in EHLO.
  ```

  Renewals: Caddy renews the cert; re-run the two `cp` lines + `restart mail`
  (or add them to a monthly cron) so the mail server picks up the new cert. If
  you prefer a dedicated cert, point `COGETO_MAIL_TLS_CERT`/`_KEY` at it instead.

- **Sender SPF authentication (SEC-1).** Cogeto now captures a message for the
  registered user it claims to be from **only if the sending server passes SPF**
  for that sender's domain — so a spoofed `MAIL FROM` from an unauthorised host
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
as the admin user (`admin@<domain>`), with one sender address you control
allowlisted for the test.

- [ ] **HTTPS login**: `https://<domain>` serves a valid Let's Encrypt
      certificate and the login page; the admin can sign in and reach the
      dashboard. The nav footer shows the expected version.
- [ ] **Status green**: `sudo ./cogeto status` → `VERDICT: GREEN` (containers
      healthy, `/api/health` all ok, TLS valid, versions match).
- [ ] **Email lands** (sender-routed, decision 0031): as the **customer
      user**, forward any short real message **from the address their user is
      registered with** to `capture@in.<domain>` — no configuration needed;
      within a minute or two it appears as a source and produces memories
      (Memories page). A **stranger's** mail must be refused (no source; the
      sender gets an SMTP 550; the refusal shows under "Recently refused"
      with its reason). Mail from the **admin account's** address is refused
      too — the operator login never captures.
- [ ] **Reply draft**: open the test email's source drawer → **Draft reply**
      → a pending draft appears in **Approvals**; approving it finalises a
      copy-ready draft (`.eml` / copy / mailto) and **sends nothing**.
- [ ] **Deletion receipt**: delete the test email source (source drawer →
      delete) → **Forgotten** shows a signed receipt that verifies (chain OK),
      counting the memories and objects it erased.
- [ ] **Passport export**: **Settings → Export my data · Memory Passport** →
      export completes and the `.zip` downloads (contains `manifest.json`,
      `manifest.json.sig`, `memories.json`, `tasks.json`, `receipts.json`).
- [ ] **Status still green** after all of the above (the deletion sweep and
      queue stay clean): `sudo ./cogeto status`.

If any box fails, stop and see section 7 (troubleshooting) — do not onboard
onto a yellow instance.

---

## 4. Onboarding the customer

1. **Create their user** in Zitadel — follow
   [`docs/operations/adding-users.md`](operations/adding-users.md) (Console at
   `https://<domain>/ui/console` → Users → **+ New**). **Use "Set initial
   password"** and hand it over out-of-band — never "Send an email
   invitation": the instance has no outbound SMTP, so invitations silently
   never arrive. Register the user with **the email address they will
   forward mail from** — that address routes their email capture (decision
   0031). No app-side step: Cogeto provisions on first login. Roles are not
   needed in v1; the `admin` role is only for the operator's System view.
2. **First login together**: the customer signs in at `https://<domain>`,
   lands on an empty dashboard (empty states everywhere are correct).
3. **Default scope**: in **Settings**, set their default capture scope —
   **private** is the default and right for a single-user instance; explain
   that shared scope only matters if teammates are added later.
4. **Email capture setup** (sender-routed, decision 0031):
   - Show **Settings → Email capture**: their inbound address
     (`capture@in.<domain>`, copy button) and their **always-trusted own
     address** — anything they **forward** or **BCC** from it is captured
     for them automatically, nothing to configure.
   - The **allowlist** is for *external* senders: entries route mail from
     those senders (typically provider-side **auto-forward rules**) into
     *their* memory. Each user keeps their own list; whole domains work
     (`adriatic-foods.hr` — subdomains need their own entry). Refused mail
     shows under "Recently refused" with the reason and a one-click claim.
   - State plainly: Cogeto only ever receives what reaches the inbound
     address — never mailbox credentials, never the whole inbox. Captured
     email follows their **default scope** (step 3).
   - Send one real forwarded email together and watch it become memories.
5. **First-day orientation** (15 minutes, in this order):
   - **Capture** a few real notes (meeting outcomes, commitments, decisions).
   - **Ask in chat** about something just captured — answers cite sources;
     click a citation to open the memory and its provenance.
   - **Review**: where uncertain or contradicted facts wait for their
     judgement; nothing is silently believed.
   - **Tasks**: commitments become open loops with reminders.
   - **Forgotten**: delete something and show the signed receipt — deletion
     is provable, not promised.
   - **Time travel** and the **Memory Passport** (Settings): knowledge has
     history, and all of it is exportable — they can leave anytime.
6. Record onboarding date and trial dates in the tracker (section 8).

### 4b. Model configuration and local models (Ollama)

The default configuration is EU-hosted Mistral (`sudo ./cogeto configure
--mistral-key <key>` at install). Everything below is optional and per
instance; the full reference is
[`docs/notes/model-providers.md`](notes/model-providers.md) (bring-your-own-key)
and [`docs/notes/local-models.md`](notes/local-models.md) (local runtime,
decision 0041).

To run tiers on a customer-owned **Ollama** host:

1. **On the Ollama host**: install Ollama, then `ollama pull gemma3:12b` (or
   the chosen generation model) and `ollama pull bge-m3` (embeddings).
2. **Networking**: the compose containers must reach the runtime address. A
   LAN or same-host address usually just works; for a WireGuard address the
   VM (the Docker **host**) must hold the wg route and forward traffic from
   the Docker bridge subnet (or run Ollama bound to an address the bridge can
   reach). Verify **from inside a container** before changing configuration:
   `sudo docker compose exec app node -e "fetch('http://<addr>:11434/api/tags').then(r=>r.text()).then(console.log)"`.
3. **Configure** in `/srv/cogeto/.env` — all-local:
   `COGETO_PROVIDER_PRESET=ollama-local` and
   `COGETO_OLLAMA_BASE_URL=http://<addr>:11434` — or the recommended mixed
   posture (hosted generation, local embeddings):
   `COGETO_PROVIDER_EMBEDDINGS=ollama`, `COGETO_MODEL_EMBEDDINGS=bge-m3`,
   plus the base URL. No API key is needed for Ollama.
4. **Changing the embeddings tier requires a reindex** — the instance
   refuses to boot on a changed embedding space until it runs:
   `sudo docker compose exec worker npm run reindex` (progress prints
   done/total; safe to re-run if interrupted).
5. `sudo docker compose up -d` and check `sudo ./cogeto status`: boot probes
   the runtime and **fails loudly** if it is unreachable or a model is not
   pulled (the error names the exact `ollama pull` command). Settings → Model
   configuration shows the active configuration id.

Before recommending a local preset, read the measured per-task, per-language
parity table in `docs/notes/local-models.md` — where all-local misses parity
the mixed posture stays the recommendation, and the gap is stated there.

### 4c. Optional capabilities — `cogeto features` (P6.7, decision 0055)

You never need to remember compose profiles: `sudo cogeto features` is the
one command for optional capabilities. It lists every capability (redaction,
research, demo, consoles, local-models) with its configured state and, when
the stack is running, its live health — the same registry the product shows
in **System → Capabilities**, `/api/health` reports, and every app boot logs
as one `Capabilities: ...` banner line.

```
sudo cogeto features                      # list + live health
sudo cogeto features enable research      # SearXNG on this instance; nothing external
sudo cogeto features disable research
sudo cogeto features enable local-models --base-url http://<addr>:11434
```

What enable/disable does: edits `/srv/cogeto/.env` idempotently (the
`COMPOSE_PROFILES` line plus the capability's own flags), re-applies the
stack (`docker compose up -d --remove-orphans`), waits for health, and prints
any operator TODOs. Notes per capability:

- **research** — fully local discovery (SearXNG, ~100-200 MB RAM, internal
  network only). The one optional profile in the deploy channel; nothing
  external to configure.
- **redaction** — source-checkout instances only (its image is not published;
  decision 0030) — the script says so if asked. Disabling it requires typing
  `disable redaction`: with it off, model calls send plaintext to the
  provider.
- **demo** — REFUSED on a production instance, loudly (decision 0022). Never
  enable it beside real data.
- **consoles** — dev-only profile; localhost-bound when present.
- **local-models** — wraps section 4b: sets the `ollama-local` preset and the
  base URL, and states the reindex consequence (typed confirmation both
  ways). The model pulls and the reindex remain your steps; the TODO list
  prints them.

Health is honest: an enabled capability whose service is down shows
**UNREACHABLE** here, in System, and degrades `/api/health` within ~30
seconds (20 s registry cache + the panel's 10 s poll). The two nightly jobs
(dreaming 03:30, sweep 03:00 UTC) report last run and go **overdue** after 26
hours without a successful run (`COGETO_JOBS_OVERDUE_HOURS`).

---

## 5. Backups and restore (roadmap D4)

Backups use **OVHcloud's own capability**, configured in the panel — no Cogeto
backup scripts, by design. `./cogeto backup-info` prints this checklist on the
instance.

### 5a. Enable (once per instance)

- [ ] Public Cloud → **Instances** → the instance → **⋯ → Create a backup /
      Automated backup**: enable **daily** snapshots, retention **≥ 7 days**,
      scheduled **outside 03:00–04:00 UTC** (the nightly Cogeto jobs' window).
- [ ] Record in the tracker: backup enabled (date), schedule hour.
- [ ] The instance `.env` is **also** in your vault (section 2.4) — the
      snapshot protects the box; the vault protects you if the box is gone.

### 5b. What the backup covers (and what it need not)

The snapshot images the whole disk, which includes every Docker volume and
`/srv/cogeto`. What actually matters:

| Data | Where | Must be restorable? |
| --- | --- | --- |
| **Postgres** (memories, receipts, tasks, audit — the source of truth) | `pg-data` volume | **Yes** |
| **MinIO** (original files, email raws, SSE-encrypted) | `minio-data` volume | **Yes** |
| **Receipt-signing keypair** | `instance-keys` volume (exists nowhere else) | **Yes** — without it the receipt chain cannot continue |
| Instance config + secrets | `/srv/cogeto/.env` (+ vault copy) | **Yes** |
| Zitadel (users) + its bootstrap PAT | Postgres + `zitadel-machinekey` volume | Yes (rides along) |
| **Qdrant** (vector index) | `qdrant-data` volume | **No — rebuildable**: `reindex` reconstructs it from Postgres (§A.4) |
| Caddy certificates | `caddy-data` volume | No — reissued automatically |

### 5c. Restore procedure — **rehearsed, not assumed**

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
   caught; the source of truth is Postgres — reindex reconciles them):

   ```sh
   cd /srv/cogeto && sudo docker compose exec -T app node project/src/dist/entrypoints/reindex.js
   ```

   It exits nonzero if the rebuilt index does not match the database — treat
   that as a failed restore.

4. **Repoint DNS**: update the **four records** from section 2a (three A
   records + the MX target's A record) to the new IPv4, and set the **PTR**
   of the new IP to `mail.<domain>`. Delete/retire the old instance's PTR.
5. **Verify like a new instance**: run the section 3 acceptance checklist
   (login, forwarded email lands, a **new** deletion produces a receipt and
   the chain still verifies — this proves the signing keypair survived,
   Passport export, status GREEN).
6. Decommission the failed instance (Public Cloud → Instances → delete) once
   the customer confirms normal service.

For the **rehearsal**, do steps 1–3 and 5's spot checks against the rehearsal
copy **without** step 4 (leave DNS alone — check via
`curl -k --resolve <domain>:443:<new IP> https://<domain>/api/health/live`),
then delete the rehearsal instance.

---

## 6. Upgrades and rollback

1. Read the release notes for the target version
   (github.com/Cogeto/cogeto/releases) — they state when a release changes
   the embedding model or needs anything beyond the standard flow. Releases
   flagged "pre-release" there are retired: the script refuses them
   (decision 0033).
2. **Take a fresh backup first** (section 5) — the script demands a typed
   `BACKED-UP` acknowledgment before touching anything, because migrations
   are forward-only and the only full rollback is the backup restore.
3. On the instance:

   ```sh
   sudo ./cogeto upgrade            # → latest published release (shown + confirmed)
   sudo ./cogeto upgrade 1.0.5      # → a specific supported release
   ```

   The script shows current → target, asks for a **typed confirmation**,
   pulls the signed images (refusing unpublished tags), re-runs migrations,
   restarts the stack, health-checks, and **detects itself** whether stored
   memories were embedded with a different model than configured — if so it
   offers **reindex** (typed `REINDEX` confirmation; it re-embeds via the
   model API, so it costs API calls). Say yes when it asks; there is no
   separate bookkeeping to do.

4. **Verify after**: `sudo ./cogeto status` is GREEN; log in and confirm the
   nav footer shows the new version; expect a short app/worker restart blip
   during the upgrade, nothing more. Image signatures were already verified
   during the upgrade (cosign, mandatory — decision 0033).
5. **Rollback** (the script prints this too): `sudo ./cogeto upgrade
   <previous version>` with the typed `ROLLBACK` confirmation. Know what it
   does and does not do: it rolls the **images** back; **database migrations
   are forward-only** and stay. If the newer schema broke the older app, the
   real rollback is a **backup restore** (section 5c) — which is why the
   rehearsal matters.
6. Record the upgrade (version, date, reindex yes/no) in the tracker.

---

## 7. Troubleshooting

Start every investigation the same way:

```sh
sudo ./cogeto status
```

It reports per-container health, the app's aggregate health (Postgres, Qdrant,
MinIO + encryption, migrations, **queue depth and dead-letter count**, the
deletion-sweep verdict, model gateway, mail listener), the served TLS
certificate, disk, and version drift — and it only says GREEN when everything
is actually working. The same aggregate view lives in the dashboard's
**System** panel (admin role), including the **dead-letter** list of jobs that
exhausted retries — a non-zero dead-letter count means work was lost and
always deserves a look.

Deeper logs, when needed:

```sh
cd /srv/cogeto
sudo docker compose ps
sudo docker compose logs --tail 200 app      # or: worker, mail, caddy, zitadel
```

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Browser can't reach the domain / certificate warning; status says "not from a public CA yet" | DNS not propagated (or pointing at the wrong IP) | Check section 2b `dig` commands. Fix the A record in the OVH zone; Caddy retries ACME automatically once it resolves — no restart. |
| TLS still not issued though DNS resolves | Port 80 or 443 blocked (OVH Network Firewall), or a stale old A record | Allow 80+443 on the IP's firewall; `sudo docker compose logs caddy` shows the ACME errors verbatim. |
| Forwarded mail never arrives | In order of frequency: sent from an address that is neither the user's **registered address** nor on their **allowlist** (decision 0031); MX record wrong/missing; TCP 25 blocked; wrong recipient address | Check **Settings → Email capture → Recently refused** first (a refusal row = SMTP and Haraka are fine — the reason is shown; forward from the registered address, or claim the external sender in one click). Note the **admin account never captures**. Then `dig +short MX in.<domain>`; then confirm port 25 open (firewall) and `sudo docker compose logs mail`. Recipient must be exactly `capture@in.<domain>`. |
| Mail accepted at SMTP but no memories appear | Pipeline/dead-letter problem | `sudo ./cogeto status` queue line; dashboard System → dead-letter for the failed job and its error; `sudo docker compose logs worker`. |
| Chat/extraction fail with a model error | No or invalid Mistral key | `sudo ./cogeto configure --mistral-key <key>` (the script restarts what's needed). |
| Boot fails with "Ollama runtime unreachable" | Runtime down, or the container cannot route to the address (WireGuard/bridge) | Check the runtime is up (`curl http://<addr>:11434/api/tags` from the VM), then from inside a container (section 4b step 2); fix `COGETO_OLLAMA_BASE_URL` or the host route. |
| Boot fails with "model ... is not available on the Ollama runtime" | Model never pulled on the Ollama host | Run the exact `ollama pull <model>` command from the error on the Ollama host, then `sudo docker compose up -d`. |
| Local chat/extraction times out | Model too large for the hardware, or first-load latency | Raise `COGETO_OLLAMA_TIMEOUT_ANSWER_MS` / `_PIPELINE_MS` (defaults 300000) or use a smaller model; the first call after idle loads the model into memory. |
| Status: "running image differs from configured" | An upgrade or restart did not complete | `cd /srv/cogeto && sudo docker compose up -d`, re-run status; if it persists, re-run `sudo ./cogeto upgrade <configured version>`. |
| A container is `unhealthy`/restarting | Varies — read its logs | `sudo docker compose logs --tail 200 <service>`. Disk-full is the classic silent killer: status prints `df`; volumes live under `/var/lib/docker`. |
| Deletion-sweep alert / receipt chain not green | Integrity finding — the product's core promise | Do not improvise. Read the alert in System, capture logs, and escalate to the owner before touching data. |
| Locked out of admin | Password is `ZITADEL_ADMIN_PASSWORD` in `/srv/cogeto/.env` (vault copy) | Username `admin@<domain>` at the instance login. |

---

## 8. Manual trial tracking (roadmap D4)

Trials are tracked by hand until client volume justifies automation. Keep
**one record per instance** wherever you keep operator records (a spreadsheet
is fine). Fields — this exact set, so nothing lives only in your head:

| Field | Example |
| --- | --- |
| Customer + contact | Adriatic Foods — Ana Kovač, ana@… |
| App domain | `acme.cogeto.eu` |
| Inbound address | `capture@in.acme.cogeto.eu` |
| OVH instance name / region / flavor | `cogeto-acme` / GRA / b3-8 |
| Public IPv4 | … |
| Installed (date, by whom) / current version | 2026-07-20, IG / 0.9.0 |
| Trial start / trial end / decision | 2026-07-21 / 2026-08-18 / — |
| Backup enabled (date, schedule hour) | 2026-07-20, 22:00 UTC |
| **Restore rehearsed (date)** | 2026-07-22 |
| Last upgrade (version, date, reindex?) | — |
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
```

O6 complete. Next: O7, the launch gate.
