# Inbound email: operator notes

Cogeto receives email by **forwarding** into a per-tenant, **receive-only**
Haraka SMTP server. Cogeto never holds mailbox
credentials and never reads a whole inbox: the user forwards, BCCs, or sets a
provider rule to send relevant mail to the instance's unique inbound address.
The **sender allowlist** decides whose mail is remembered; a fresh instance is
**closed by default**. Sending is out of scope.

This note covers: local test-send, the owner verification checklist, and the
DNS/MX requirements to hand to O6 provisioning.

---

## What ships in this unit (Unit A)

- A `mail` container (Haraka) in `docker compose`: receive-only, listens on
 container port `2525`, host port `25` mapped to it. **Behind the `mail`
 compose profile since security audit 2.0 (SEC-14): it is OFF by default**, so
 an instance that does not use email capture runs no internet-facing SMTP
 listener at all. See "Turning it on" below.
- An internal authenticated intake endpoint `POST /api/email/intake` (shared
 secret; never public).
- Full retention: the raw RFC822 + parsed headers + text/HTML bodies + all
 attachments are stored; supported document attachments (PDF/DOCX) are routed
 into the document pipeline as linked file sources.
- The sender allowlist (address + whole-domain entries), managed in
 **Settings → Email capture**, audited, closed by default.
- A mail health check surfaced in the dashboard System panel.

**Deferred to Unit B:** the deletion-saga coverage of email sources + receipts,
reply drafts through the approval machine, and the in-app forwarding-setup
guidance shown next to the address.

---

## Turning it on

Inbound mail is an opt-in capability, like `research` and `redaction`. Nothing
about the feature changed; what changed is that a stack without it started runs
no listener and opens no port.

**Dev / source checkout**: activate the profile.

```sh
COMPOSE_PROFILES=mail docker compose up --build
```

(Or put `COMPOSE_PROFILES=mail` in `.env`. A one-off `--profile mail` run works
too, but CLI profile flags are invisible to the container, so also set
`COGETO_MAIL_ENABLED=1` if you want the capability panel to report it honestly.)

**Customer instance**: the operator script.

```sh
sudo cogeto features enable mail    # starts the listener, opens 25/tcp, prints the MX/PTR steps
sudo cogeto features disable mail   # stops it and closes the port again
```

With the capability off, **System → Capabilities** shows `Email capture: off`
and the `mail` health check reports "inbound mail capability is off" and stays
green. A mail-less instance is not a degraded one.

An upgrade carries an instance that was **already** receiving email forward as
enabled: the script detects the existing mail container and sets the profile
itself, saying so. Nothing changes for that customer.

---

## Local test-send (no real DNS)

Bring the stack up with the mail profile active:

```sh
COMPOSE_PROFILES=mail docker compose up --build
```

Wait until the app is healthy and you can log in at `https://localhost`. Then,
in **Settings → Email capture**, add an allowlisted sender or domain, e.g. the
domain `adriatic-foods.hr`. Until you do, everything is refused (closed by
default).

Submit fixture messages over SMTP with the dev script (raw SMTP, no dependency):

```sh
# Sends BOTH demo messages: one from the allowlisted domain (accepted) and one
# from a stranger (refused). The final SMTP reply is the verdict.
node scripts/dev/send-test-email.mjs

# Or send a single message from a specific sender:
node scripts/dev/send-test-email.mjs --from ana@adriatic-foods.hr

# Attach a document (routed into the document pipeline if it's a PDF/DOCX):
node scripts/dev/send-test-email.mjs --from ana@adriatic-foods.hr --attach ./some.pdf
```

Expected: `250 queued` (⛔→ `550`) for the allowlisted sender, `550` for the
stranger. An accepted message appears as a new source; its facts flow through
the normal ingestion pipeline and show up in the dashboard with provenance to
the email.

If host port 25 is taken locally, set `COGETO_MAIL_HOST_PORT=2525` before
`docker compose up` and pass `--port 2525` to the script.

---

## Owner verification checklist

- [ ] `docker compose up` reaches the login page on a fresh clone (email
 capture needs `COMPOSE_PROFILES=mail`).
- [ ] The dashboard **System** panel shows the **mail** check green (the Haraka
 SMTP listener is reachable).
- [ ] **Settings → Email capture** shows the inbound address and an empty
 allowlist with the "closed by default" notice.
- [ ] Adding an address and a domain entry works and is reflected immediately;
 each add/remove appears in the audit trail.
- [ ] `node scripts/dev/send-test-email.mjs` → the allowlisted sender is
 **accepted** (`250`) and the stranger is **refused** (`550`).
- [ ] An accepted message produces memories with provenance to the email; a PDF
 attachment produces a linked file source; a `.txt` attachment is recorded
 but not processed.
- [ ] A refused message leaves **no** stored source/object: only a metadata-only
 refusal row (visible as "Recently refused" in Settings, ready for one-click
 allowlisting).
- [ ] Oversize mail and mail to a wrong recipient are refused at SMTP.

---

## DNS / MX / TLS requirements for O6 provisioning

The per-instance inbound address is `capture@in.<instance>.cogeto.eu` (the local
part is the fixed literal `capture`; the tenant is the **subdomain**). To point
real mail at a tenant's box, O6 must configure, per instance:

1. **MX record** for the inbound subdomain, pointing at the instance host:

 ```
 in.<instance>.cogeto.eu. IN MX 10 mail.<instance>.cogeto.eu.
 mail.<instance>.cogeto.eu. IN A <instance public IPv4>
 ; (add an AAAA record if the instance has a public IPv6)
 ```

2. **PTR (reverse DNS)** for the instance IP → `mail.<instance>.cogeto.eu`, set
 in the OVHcloud panel. Many senders soft-reject hosts without matching
 forward/reverse DNS.

3. **SPF** for the inbound subdomain is not required for *receiving*, but if the
 apex domain publishes a strict SPF, ensure it does not interfere. (Cogeto
 never sends, so no outbound SPF/DKIM/DMARC is needed for this address.)

4. **Inbound TLS (STARTTLS). Automatic; nothing to source, copy or renew.**
 This is the one description of how inbound-mail TLS works; every other
 document points here.

 The mechanism, end to end:

 - `cogeto features enable mail` writes `COGETO_MAIL_TLS_SITE=mail.<domain>`
 (the same `derive_mx_host` value it prints as the required A record) and
 prints that record.
 - The edge's Caddyfile carries an **ACME-only vhost** for that hostname: it
 exists purely so a certificate is ordered and renewed, and answers `404`
 to anything that reaches it, because the mail host serves SMTP and no web
 surface. With `COGETO_MAIL_TLS_SITE` empty the vhost falls back to an
 inert `http://mail-tls-disabled.invalid` placeholder, so an instance without email
 capture orders nothing.
 - The **`mail-tls-sync` sidecar** (the edge image, its own container under
 the `mail` profile) reads `caddy-data` read-only, and whenever the
 material for that hostname changes, writes `cert.pem` + `key.pem` into the
 `mail-tls` volume owned by `1000:1000` with mode `0644`/`0640`.
 - The **mail container mounts `mail-tls` only**, never `caddy-data`. It is
 internet-facing, so it must never hold the edge's other keys; that
 boundary is why propagation is a sidecar rather than a second mount.
 - The **mail entrypoint watches its own copy** and, when it changes, exits
 so compose restarts it with the new certificate. Haraka reads the PEM
 files once at startup, so a restart is how a renewal takes effect; it is
 conditional on the material actually changing, so a steady state restarts
 nothing.

 **Verifying it**, from outside the instance:

 ```sh
 openssl s_client -starttls smtp -connect mail.acme.cogeto.eu:25 -crlf </dev/null
 ```

 and on the instance `sudo cogeto status`, which prints whether STARTTLS is
 advertised and when the certificate expires. The `mail` capability in
 `/api/health` and the System panel names the same fact. A cleartext
 downgrade used to be invisible; it is not any more.

 **Why it is built rather than documented.** The consuming half (the
 dedicated volume, the mount, the entrypoint that enables Haraka's `tls`
 plugin) shipped with the first mail commit and worked. The producing half
 was never built, so no certificate for the mail hostname was ever issued
 and the runbook's copy-it-yourself procedure pointed at a directory that
 did not exist. A manual copy would also have inherited exactly the failure
 this removes: the certificate renews every 60 days, silently, and a
 forgotten copy downgrades the listener with nothing saying so.

5. **Firewall.** Open inbound TCP **25** to the instance. `cogeto features
 enable mail` does this in `ufw` for you, but a cloud-provider network
 firewall is a separate, manual step. Note some cloud providers block
 outbound 25 by default, irrelevant here (receive-only), but inbound 25 must
 be reachable.

6. **Per-instance secrets** the provisioning step must generate and set on
 **both** the app and the `mail` service so they agree:
 - `COGETO_MAIL_INBOUND_ADDRESS`: the exact accepted recipient.
 - `COGETO_MAIL_INTAKE_TOKEN`: the shared secret for the internal intake
 (fail-closed: an empty token disables the endpoint).
 The app additionally reads `COGETO_MAIL_SMTP_ADDRESS` (default `mail:2525`)
 for its health probe, and `COGETO_ADMIN_USER_EMAIL` (compose wires it from
 `ZITADEL_ADMIN_USERNAME`): the operator admin account is excluded from
 capture. There is no capture-owner pin: recipients are resolved from the
 **sender** (a registered user's own address routes to them; other senders route by
 each user's personal allowlist).

### Operator-supplied certificates: an override

If your organisation has its own CA, or a wildcard you already manage, you can
supply the material yourself instead. This is an **override, not the default**,
and renewal then becomes **your responsibility**: nothing will warn you before
it expires except `cogeto status`.

Requirements, exactly:

| What | Requirement |
| --- | --- |
| Files | `cert.pem` and `key.pem` in the `cogeto_mail-tls` volume (or wherever `COGETO_MAIL_TLS_CERT` / `COGETO_MAIL_TLS_KEY` point inside the container) |
| Format | PEM. `cert.pem` is the leaf followed by any intermediates; `key.pem` is the unencrypted private key (Haraka cannot prompt for a passphrase) |
| Ownership | readable by **uid 1000** (`chown 1000:1000`), mode `0644` for the certificate and `0640` for the key |
| Hostname | must match the MX target, `mail.<domain>` |

The ownership line is the silent trap and the reason it is spelled out: the
entrypoint's readability test runs as the container's non-root user, so
root-only material is indistinguishable from no material at all, and the
result is a cleartext listener that looks healthy.

To use the override, leave `COGETO_MAIL_TLS_SITE` empty (so the edge orders
nothing and `mail-tls-sync` idles rather than overwriting your files) and place
the two files in the volume:

```sh
TLSDIR=$(sudo docker volume inspect --format '{{ .Mountpoint }}' cogeto_mail-tls)
sudo install -o 1000 -g 1000 -m 0644 your-cert.pem "$TLSDIR/cert.pem"
sudo install -o 1000 -g 1000 -m 0640 your-key.pem "$TLSDIR/key.pem"
# The mail service notices within seconds and restarts to load them.
```

Renewals are the same two commands; the watcher picks them up with no restart
command of your own.

### Verification after provisioning

```sh
# From an external host, confirm the MX resolves and the port answers:
dig +short MX in.<instance>.cogeto.eu
swaks --to capture@in.<instance>.cogeto.eu --from you@yourdomain.com --server in.<instance>.cogeto.eu
```

An allowlisted `--from` should be accepted (`250`); anything else refused
(`550`). Then confirm the message lands in the tenant's dashboard.
