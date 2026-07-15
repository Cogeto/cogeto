# Inbound email — operator notes (Session O4)

Cogeto receives email by **forwarding** into a per-tenant, **receive-only**
Haraka SMTP server ([decision 0028](../decisions/0028-inbound-email-design.md);
roadmap [D2](../Cogeto-v1-Roadmap-Revision.md)). Cogeto never holds mailbox
credentials and never reads a whole inbox: the user forwards, BCCs, or sets a
provider rule to send relevant mail to the instance's unique inbound address.
The **sender allowlist** decides whose mail is remembered; a fresh instance is
**closed by default**. Sending is out of scope.

This note covers: local test-send, the owner verification checklist, and the
DNS/MX requirements to hand to O6 provisioning.

---

## What ships in this unit (Unit A)

- A `mail` container (Haraka) in `docker compose` — receive-only, listens on
  container port `2525`, host port `25` mapped to it.
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

## Local test-send (no real DNS)

Bring the stack up (the mail service builds and starts with everything else):

```sh
docker compose up --build
```

Wait until the app is healthy and you can log in at `https://localhost`. Then,
in **Settings → Email capture**, add an allowlisted sender or domain — e.g. the
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

- [ ] `docker compose up` reaches the login page on a fresh clone.
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
- [ ] A refused message leaves **no** stored source/object — only a metadata-only
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
   in.<instance>.cogeto.eu.   IN  MX  10  mail.<instance>.cogeto.eu.
   mail.<instance>.cogeto.eu. IN  A       <instance public IPv4>
   ; (add an AAAA record if the instance has a public IPv6)
   ```

2. **PTR (reverse DNS)** for the instance IP → `mail.<instance>.cogeto.eu`, set
   in the OVHcloud panel. Many senders soft-reject hosts without matching
   forward/reverse DNS.

3. **SPF** for the inbound subdomain is not required for *receiving*, but if the
   apex domain publishes a strict SPF, ensure it does not interfere. (Cogeto
   never sends, so no outbound SPF/DKIM/DMARC is needed for this address.)

4. **Inbound TLS (STARTTLS).** The Haraka container speaks plain SMTP on `2525`;
   the deployment terminates/permits TLS. Two supported patterns:
   - Provide the instance's Let's Encrypt cert/key to Haraka (mount + enable the
     `tls` plugin) so it offers STARTTLS on port 25 directly; **or**
   - Front port 25 with a TLS-terminating TCP proxy that forwards cleartext to
     `2525`.
   The website already obtains a Let's Encrypt cert for the app; O6 reuses that
   ACME setup to cover `mail.<instance>` / `in.<instance>`.

5. **Firewall.** Open inbound TCP **25** to the instance. Note some cloud
   providers block outbound 25 by default — irrelevant here (receive-only), but
   inbound 25 must be reachable.

6. **Per-instance secrets** the provisioning step must generate and set on
   **both** the app and the `mail` service so they agree:
   - `COGETO_MAIL_INBOUND_ADDRESS` — the exact accepted recipient.
   - `COGETO_MAIL_INTAKE_TOKEN` — the shared secret for the internal intake
     (fail-closed: an empty token disables the endpoint).
   The app additionally reads `COGETO_MAIL_SMTP_ADDRESS` (default `mail:2525`)
   for its health probe, and `COGETO_ADMIN_USER_EMAIL` (compose wires it from
   `ZITADEL_ADMIN_USERNAME`) — the operator admin account is excluded from
   capture. There is no capture-owner pin: recipients are resolved from the
   **sender** ([decision 0031](../decisions/0031-sender-routed-inbound-email.md)
   — a registered user's own address routes to them; other senders route by
   each user's personal allowlist).

### Verification after provisioning

```sh
# From an external host, confirm the MX resolves and the port answers:
dig +short MX in.<instance>.cogeto.eu
swaks --to capture@in.<instance>.cogeto.eu --from you@yourdomain.com --server in.<instance>.cogeto.eu
```

An allowlisted `--from` should be accepted (`250`); anything else refused
(`550`). Then confirm the message lands in the tenant's dashboard.
