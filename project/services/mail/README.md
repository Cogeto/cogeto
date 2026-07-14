# cogeto-mail — per-tenant, receive-only inbound SMTP (Haraka)

Session O4, [decision 0028](../../../docs/decisions/0028-inbound-email-design.md);
roadmap [D2](../../../docs/Cogeto-v1-Roadmap-Revision.md). One more container in
the single-tenant deployment. It accepts forwarded mail for **one** inbound
address, applies recipient/size/rate hygiene, and hands the **full raw message**
to the Cogeto app over an internal authenticated HTTP endpoint. It **never
sends** — outbound is disabled (decision 0028 ruling 4). No dependency on the
TypeScript workspace.

## Shape

```
package.json                 Haraka + haraka-constants (pinned)
Dockerfile                   node:22-alpine (pinned by digest), non-root, listens on 2525
docker-entrypoint.sh         derives host_list/me/databytes from env, starts Haraka
haraka/config/plugins        limit → cogeto_rcpt → cogeto_deliver (no outbound)
haraka/config/smtp.ini       listen :2525, SIZE, outbound disabled
haraka/config/limit.ini      per-connection concurrency + connection/recipient rate
haraka/plugins/cogeto_rcpt   accept ONLY the instance inbound address (else SMTP 550)
haraka/plugins/cogeto_deliver POST raw RFC822 to the app; map HTTP verdict → SMTP reply
```

## Acceptance flow (decision 0028 rulings 6/7)

1. **RCPT** — `cogeto_rcpt` accepts only `COGETO_MAIL_INBOUND_ADDRESS`; anything
   else is `550`.
2. **DATA size** — `config/databytes` (from `COGETO_MAIL_MAX_BYTES`) caps the
   message; oversize is refused via SMTP `SIZE`.
3. **Rate/concurrency** — `limit` bounds per-host connections and recipients.
4. **QUEUE** — `cogeto_deliver` POSTs the raw message to the app's internal
   intake with the shared-secret bearer. The **app is the authoritative gate**
   (allowlist + owner + size); Haraka surfaces its verdict as the SMTP reply:
   `200→250 queued`, `403→550 refused`, `413→552 too large`, `5xx/network→451`.

The allowlist itself lives entirely in the app — the mail service holds no
per-sender state.

## Environment

| Var | Purpose |
| --- | --- |
| `COGETO_MAIL_INBOUND_ADDRESS` | the one accepted recipient, e.g. `capture@in.acme.cogeto.eu` |
| `COGETO_MAIL_MAX_BYTES` | hard message-size cap (default 25 MB) |
| `COGETO_INTAKE_URL` | the app intake, e.g. `http://app:3000/api/email/intake` |
| `COGETO_MAIL_INTAKE_TOKEN` | shared secret presented to the intake (must match the app) |

## TLS / MX (operator, O6)

The container speaks plain SMTP on 2525; the deployment maps the standard
inbound port `25 → 2525`. Inbound STARTTLS with the instance certificate and the
`in.<instance>` **MX** record are provisioning concerns handed to O6 — see
[`docs/notes/email-inbound.md`](../../../docs/notes/email-inbound.md) for the
exact DNS/MX/SPF/PTR requirements and the local test-send steps.

Local development uses `scripts/dev/send-test-email.mjs` to submit fixtures over
SMTP without real DNS.
