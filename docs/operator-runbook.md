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

   The script verifies OS/resources, installs Docker, generates all secrets
   into `/srv/cogeto/.env` (mode 600), derives the inbound address
   (`capture@in.<domain>`), pulls the three signed images, brings the stack
   up, and waits for health. It ends with the **WHAT YOU MUST DO NOW**
   checklist — everything below is that checklist, expanded with the OVH
   panel locations.

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
- [ ] **Email lands**: in **Settings → Email capture**, allowlist your test
      sender. From that mailbox, forward any short real message to
      `capture@in.<domain>`. Within a minute or two the email appears as a
      source and produces memories with provenance to it (Memories page).
      A non-allowlisted sender must be refused (no source appears; the sender
      gets an SMTP 550; the refusal shows under "Recently refused").
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
   [`docs/operations/adding-users.md`](operations/adding-users.md) (Console →
   Users → **+ New**; email invitation or initial password out-of-band). No
   app-side step: Cogeto provisions on first login. Roles are not needed in
   v1; the `admin` role is only for the operator's System view.
2. **First login together**: the customer signs in at `https://<domain>`,
   lands on an empty dashboard (empty states everywhere are correct).
3. **Default scope**: in **Settings**, set their default capture scope —
   **private** is the default and right for a single-user instance; explain
   that shared scope only matters if teammates are added later.
4. **Email capture setup** (the one thing worth doing carefully):
   - Show **Settings → Email capture**: their inbound address
     (`capture@in.<domain>`, copy button) and the sender **allowlist** —
     closed by default; only allowlisted senders' mail is remembered.
   - Have them allowlist their own address and their key correspondents (or
     whole domains, e.g. `adriatic-foods.hr` — subdomains need their own
     entry).
   - Walk through the three ways to use the address (the Settings page shows
     the same guidance): **forward** a relevant message, **BCC** the address
     on mail they send, or set a **provider-side auto-forward rule** for
     chosen senders. State plainly: Cogeto only ever receives what they
     forward — never mailbox credentials, never the whole inbox.
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
   the embedding model or needs anything beyond the standard flow.
2. On the instance:

   ```sh
   sudo ./cogeto upgrade            # → latest published release
   sudo ./cogeto upgrade 0.10.0     # → a specific published release
   ```

   The script shows current → target, asks for a **typed confirmation**,
   pulls the signed images (refusing unpublished tags), re-runs migrations,
   restarts the stack, health-checks, and **detects itself** whether stored
   memories were embedded with a different model than configured — if so it
   offers **reindex** (typed `REINDEX` confirmation; it re-embeds via the
   model API, so it costs API calls). Say yes when it asks; there is no
   separate bookkeeping to do.

3. **Verify after**: `sudo ./cogeto status` is GREEN; log in and confirm the
   nav footer shows the new version; expect a short app/worker restart blip
   during the upgrade, nothing more.
4. **Rollback** (the script prints this too): `sudo ./cogeto upgrade
   <previous version>` with the typed `ROLLBACK` confirmation. Know what it
   does and does not do: it rolls the **images** back; **database migrations
   are forward-only** and stay. If the newer schema broke the older app, the
   real rollback is a **backup restore** (section 5c) — which is why the
   rehearsal matters.
5. Record the upgrade (version, date, reindex yes/no) in the tracker.

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
| Forwarded mail never arrives | In order of frequency: sender not on the **allowlist**; MX record wrong/missing; TCP 25 blocked; wrong recipient address | Check **Settings → Email capture → Recently refused** first (a refusal row = SMTP and Haraka are fine — allowlist the sender, one click). Then `dig +short MX in.<domain>`; then confirm port 25 open (firewall) and `sudo docker compose logs mail`. Recipient must be exactly `capture@in.<domain>`. |
| Mail accepted at SMTP but no memories appear | Pipeline/dead-letter problem | `sudo ./cogeto status` queue line; dashboard System → dead-letter for the failed job and its error; `sudo docker compose logs worker`. |
| Chat/extraction fail with a model error | No or invalid Mistral key | `sudo ./cogeto configure --mistral-key <key>` (the script restarts what's needed). |
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
