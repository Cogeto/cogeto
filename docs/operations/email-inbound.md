# Inbound email: operator notes

Cogeto receives email by **forwarding** into a per-instance, **receive-only**
Haraka SMTP server. Cogeto never holds mailbox credentials and never reads a
whole inbox: the user forwards, BCCs, or sets a provider rule to send relevant
mail to the instance's unique inbound address. Sending is out of scope.

This note is the authority on three things: **how capture routes**, the
**DNS, TLS and firewall requirements**, and the **local test-send**. Where
another document mentions any of them it points here rather than restating.
The lifecycle around it (when to turn it on, what to tell a customer) is the
[operator runbook](../operator-runbook.md) sections 2c and 4.

---

## What it is

- A `mail` container (Haraka) in `docker compose`: receive-only, listening on
  container port `2525`, host port `25` mapped to it. **Behind the `mail`
  compose profile since security audit 2.0 (SEC-14): it is OFF by default**, so
  an instance that does not use email capture runs no internet-facing SMTP
  listener at all.
- An internal authenticated intake endpoint `POST /api/email/intake` (shared
  secret; never public, and 404'd at the edge).
- Full retention: the raw RFC822 plus parsed headers, text and HTML bodies and
  all attachments are stored; supported document attachments are routed into
  the document pipeline as linked file sources.
- The per-user sender allowlist, managed in **Settings → Email capture**,
  audited.
- A mail health check surfaced in `/api/health`, the dashboard System panel and
  `cogeto status`.

## How capture routes: by sender

This is the part most often misremembered. There is no capture owner and no
per-instance recipient rule; the **sender** decides where a message lands.

1. **A registered user's own address routes to that user.** Nothing to
   configure: whatever they forward or BCC from the address their account is
   registered with becomes their memory, under their default scope.
2. **Any other sender routes by allowlist.** Each user keeps their own list of
   external addresses and whole domains; a message from a sender on someone's
   list is captured for that user. A sender on nobody's list is refused, and
   the refusal shows under "Recently refused" with its reason and a one-click
   claim.
3. **The bootstrap admin account never captures.** The operator login is
   excluded outright, so an operator's own forwarded mail cannot become the
   instance's memory.
4. **Sender authentication gates rule 1** (SEC-1, `COGETO_MAIL_REQUIRE_SPF`,
   on by default): the self-route needs an SPF `pass`, so a spoofed `MAIL FROM`
   cannot inject memory into a user's account. A hard SPF `fail` or `softfail`
   is refused outright, whatever the routing would have been.

An empty allowlist therefore means "no external senders", not "nothing is
captured": a registered user forwarding from their own address is captured on
day one.

---

## Local test-send (no real DNS)

Bring the stack up with the mail profile active:

```sh
COMPOSE_PROFILES=mail docker compose up --build
```

(Or put `COMPOSE_PROFILES=mail` in `.env`. A one-off `--profile mail` run works
too, but CLI profile flags are invisible to the container, so also set
`COGETO_MAIL_ENABLED=1` if you want the capability panel to report it
honestly.)

Wait until the app is healthy and you can log in at `https://localhost`. The
dev fixtures send from `adriatic-foods.hr`, which is nobody's registered
address, so in **Settings → Email capture** add that domain to a user's
allowlist first; without it both fixtures are refused, which is also a valid
thing to observe.

```sh
# Sends BOTH demo messages: one from the allowlisted domain (accepted) and one
# from a stranger (refused). The final SMTP reply is the verdict.
node scripts/dev/send-test-email.mjs

# Or send a single message from a specific sender:
node scripts/dev/send-test-email.mjs --from ana@adriatic-foods.hr

# Attach a document (routed into the document pipeline if the reader supports it):
node scripts/dev/send-test-email.mjs --from ana@adriatic-foods.hr --attach ./some.pdf
```

Expected: `250 queued` for the routed sender, `550` for the stranger. An
accepted message appears as a new source; its facts flow through the normal
ingestion pipeline with provenance to the email.

If host port 25 is taken locally, set `COGETO_MAIL_HOST_PORT=2525` before
`docker compose up` and pass `--port 2525` to the script.

---

## Turning it on

**Dev / source checkout**: activate the profile, as above.

**Customer instance**: the operator script.

```sh
sudo cogeto features enable mail    # starts the listener, opens 25/tcp, prints the MX/PTR steps
sudo cogeto features disable mail   # stops it and closes the port again
```

With the capability off, **System → Capabilities** shows `mail: off` and the
`mail` health check reports "inbound mail capability is off" and stays green.
A mail-less instance is not a degraded one.

---

## Verification checklist

- [ ] `docker compose up` reaches the login page on a fresh clone (email
      capture needs `COMPOSE_PROFILES=mail`).
- [ ] The dashboard **System** panel shows the **mail** check green (the Haraka
      SMTP listener is reachable).
- [ ] **Settings → Email capture** shows the inbound address and the user's own
      always-trusted address.
- [ ] Adding an address and a domain entry works and is reflected immediately;
      each add/remove appears in the audit trail.
- [ ] `node scripts/dev/send-test-email.mjs` → the routed sender is
      **accepted** (`250`) and the stranger is **refused** (`550`).
- [ ] An accepted message produces memories with provenance to the email; a PDF
      attachment produces a linked file source; a `.txt` attachment is recorded
      but not processed.
- [ ] A refused message leaves **no** stored source or object: only a
      metadata-only refusal row (visible as "Recently refused" in Settings,
      ready for one-click allowlisting).
- [ ] Oversize mail and mail to a wrong recipient are refused at SMTP.

---

## DNS, TLS and firewall

The per-instance inbound address is `capture@in.<domain>` (the local part is
the fixed literal `capture`; the instance is the **subdomain**).
`cogeto features enable mail` prints every record below with the instance's
real values; these are the requirements behind that output.

### 1. MX and A records

```
in.<domain>.    IN MX 10 mail.<domain>.
mail.<domain>.  IN A     <instance public IPv4>
; (add an AAAA record if the instance has a public IPv6)
```

### 2. PTR (reverse DNS)

Set the reverse of the instance IP to `mail.<domain>`, in the hosting
provider's panel. Many senders soft-reject hosts without matching
forward/reverse DNS.

### 3. SPF

Not required for *receiving*. If the apex domain publishes a strict SPF, check
that it does not claim the `in.<domain>` subdomain. Cogeto never sends, so no
outbound SPF, DKIM or DMARC is needed for this address. What DOES matter is the
**sending** side: a user's own domain should publish SPF so their self-captured
mail authenticates (see routing rule 4 above).

### Inbound TLS (STARTTLS)

**Automatic. Nothing to source, copy or renew.** This is the one description of
the mechanism; every other document points here.

It belongs to the **customer stack**: the certificate is a real one for a real
hostname, so a source checkout has neither the sidecar nor the volume and its
listener is deliberately cleartext (`cogeto status` and the `mail` capability
say so rather than implying otherwise).

End to end, on a customer instance:

- `cogeto features enable mail` writes `COGETO_MAIL_TLS_SITE=mail.<domain>`
  (the same `derive_mx_host` value it prints as the required A record), unless
  the instance is in operator-supplied mode, which is the override below and is
  left alone by every path that would otherwise converge this.
- The edge's Caddyfile carries an **ACME-only vhost** for that hostname: it
  exists purely so a certificate is ordered and renewed, and answers `404` to
  anything that reaches it, because the mail host serves SMTP and no web
  surface. With `COGETO_MAIL_TLS_SITE` empty the vhost falls back to an inert
  `http://mail-tls-disabled.invalid` placeholder, so an instance without email
  capture orders nothing.
- The **`mail-tls-sync` sidecar** (the edge image, its own container under the
  `mail` profile) reads `caddy-data` read-only and, whenever the material for
  that hostname changes, writes `cert.pem` and `key.pem` into the `mail-tls`
  volume owned by `1000:1000` with mode `0644`/`0640`.
- The **mail container mounts `mail-tls` only**, never `caddy-data`. It is
  internet-facing, so it must never hold the edge's other keys; that boundary
  is why propagation is a sidecar rather than a second mount.
- The **mail entrypoint watches its own copy** and, when it changes, exits so
  compose restarts it with the new certificate. Haraka reads the PEM files once
  at startup, so a restart is how a renewal takes effect; it is conditional on
  the material actually changing, so a steady state restarts nothing.

**Verifying it**, from outside the instance:

```sh
openssl s_client -starttls smtp -connect mail.<domain>:25 -crlf </dev/null
```

and on the instance `sudo cogeto status`, which prints whether STARTTLS is
advertised and when the certificate expires. The `mail` capability in
`/api/health` and the System panel names the same fact, so a cleartext
downgrade is visible rather than silent.

If it reports CLEARTEXT, the usual cause is that the `mail.<domain>` A record
does not resolve yet. Check `dig +short A mail.<domain>` and, if that is fine,
read `sudo docker compose logs --tail 50 mail-tls-sync` in `/srv/cogeto`.

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
root-only material is indistinguishable from no material at all, and the result
is a cleartext listener that looks healthy.

To use the override, **record the decision first** and then place the files:

```sh
sudo cogeto configure --mail-tls-mode operator

TLSDIR=$(sudo docker volume inspect --format '{{ .Mountpoint }}' cogeto_mail-tls)
sudo install -o 1000 -g 1000 -m 0644 your-cert.pem "$TLSDIR/cert.pem"
sudo install -o 1000 -g 1000 -m 0640 your-key.pem "$TLSDIR/key.pem"
# The mail service notices within seconds and restarts to load them.
```

Renewals are the same two `install` commands; the watcher picks them up with no
restart command of your own.

`--mail-tls-mode operator` writes `COGETO_MAIL_TLS_MODE=operator` into the
instance `.env` and blanks `COGETO_MAIL_TLS_SITE`, and **that recorded mode is
what makes the override survive**. Blanking the site alone is not enough and
used to be the whole instruction here: every convergence path in the operator
script (`upgrade`, `features enable mail`, `features disable mail`,
`configure --domain`) set the site back from the domain, so the next upgrade
silently returned the instance to automatic, and once `mail.<domain>` resolved
the edge ordered a certificate and the sidecar overwrote `cert.pem` and
`key.pem`. With the mode recorded:

- **Every one of those paths leaves the configuration alone**, and says so when
  it runs. Nothing orders a certificate for the mail hostname, and
  `mail-tls-sync` idles instead of copying, so your material is never
  overwritten. The sidecar honours the mode itself, not only the empty site.
- `cogeto configure` with no arguments prints which mode the instance is in, and
  `cogeto status` says the certificate is operator-supplied and that **nothing
  renews it for you**.
- **Going back is deliberate, never a side effect**: `sudo cogeto configure
  --mail-tls-mode automatic` asks you to type a confirmation, because from that
  moment the edge orders its own certificate for `mail.<domain>` and the sidecar
  overwrites the two files in the volume with it.

### Firewall

Open inbound TCP **25** to the instance. `cogeto features enable mail` does
this in `ufw` for you, but a cloud-provider network firewall is a separate,
manual step. Some cloud providers block *outbound* 25 by default, which is
irrelevant here (receive-only), but inbound 25 must be reachable.

### The per-instance secrets behind it

Generated by `cogeto install` and set on **both** the app and the `mail`
service so they agree:

- `COGETO_MAIL_INBOUND_ADDRESS`: the exact accepted recipient.
- `COGETO_MAIL_INTAKE_TOKEN`: the shared secret for the internal intake
  (fail-closed: an empty token disables the endpoint).

The app additionally reads `COGETO_MAIL_SMTP_ADDRESS` (default `mail:2525`) for
its health probe, and `COGETO_ADMIN_USER_EMAIL` (compose wires it from
`ZITADEL_ADMIN_USERNAME`), which is how the operator admin account is excluded
from capture.

### Verification after the records resolve

```sh
# From an external host, confirm the MX resolves and the port answers:
dig +short MX in.<domain>
swaks --to capture@in.<domain> --from you@yourdomain.com --server in.<domain>
```

A `--from` that routes (a registered user's own address, or an allowlisted
sender) should be accepted (`250`); anything else refused (`550`). Then confirm
the message lands in that user's dashboard.
