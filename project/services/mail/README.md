# cogeto-mail: per-tenant, receive-only inbound SMTP (Haraka)

One more container in
the single-tenant deployment. It accepts forwarded mail for **one** inbound
address, applies recipient/size/rate hygiene, and hands the **full raw message**
to the Cogeto app over an internal authenticated HTTP endpoint. It **never
sends**, outbound is disabled. No dependency on the
TypeScript workspace.

## Shape

```
package.json Haraka + haraka-constants (pinned)
Dockerfile node:24-alpine (pinned by digest), non-root, listens on 2525
docker-entrypoint.sh derives host_list/me/databytes from env, starts Haraka
haraka/config/plugins limit → cogeto_rcpt → cogeto_deliver (no outbound)
haraka/config/smtp.ini listen :2525, SIZE, outbound disabled
haraka/config/limit.ini per-connection concurrency + connection/recipient rate
haraka/plugins/cogeto_rcpt accept ONLY the instance inbound address (else SMTP 550)
haraka/plugins/cogeto_deliver POST raw RFC822 to the app; map HTTP verdict → SMTP reply
```

## Acceptance flow

1. **RCPT**: `cogeto_rcpt` accepts only `COGETO_MAIL_INBOUND_ADDRESS`; anything
 else is `550`.
2. **DATA size**: `config/databytes` (from `COGETO_MAIL_MAX_BYTES`) caps the
 message; oversize is refused via SMTP `SIZE`.
3. **Rate/concurrency**: `limit` bounds per-host connections and recipients.
4. **QUEUE**: `cogeto_deliver` POSTs the raw message to the app's internal
 intake with the shared-secret bearer. The **app is the authoritative gate**
 (allowlist + owner + size); Haraka surfaces its verdict as the SMTP reply:
 `200→250 queued`, `403→550 refused`, `413→552 too large`, `5xx/network→451`.

The allowlist itself lives entirely in the app: the mail service holds no
per-sender state.

## Environment

| Var | Purpose |
| --- | --- |
| `COGETO_MAIL_INBOUND_ADDRESS` | the one accepted recipient, e.g. `capture@in.acme.cogeto.eu` |
| `COGETO_MAIL_MAX_BYTES` | hard message-size cap (default 25 MB) |
| `COGETO_INTAKE_URL` | the app intake, e.g. `http://app:3000/api/email/intake` |
| `COGETO_MAIL_INTAKE_TOKEN` | shared secret presented to the intake (must match the app) |

## TLS / MX (operator)

The container speaks plain SMTP on 2525; the deployment maps the standard
inbound port `25 → 2525`. STARTTLS is enabled by the entrypoint whenever a
**readable** cert/key pair is present in the mounted `mail-tls` volume, and the
entrypoint watches that pair so a renewal is loaded without anyone doing
anything (it exits and compose restarts it; Haraka reads the PEMs once at
startup). Readable means readable by uid 1000, the non-root user this container
runs as: root-only material is indistinguishable here from no material, and the
result is a silent cleartext listener.

Putting the certificate there is not this image's job. On a deployed instance
the edge obtains it for `mail.<domain>` and the `mail-tls-sync` sidecar copies
it in; a dev box mounts nothing and simply does not advertise STARTTLS. See
[`docs/operations/email-inbound.md`](../../../docs/operations/email-inbound.md)
for the whole mechanism, the operator-supplied-certificate override, and the
DNS/MX/SPF/PTR requirements.

Local development uses `scripts/dev/send-test-email.mjs` to submit fixtures over
SMTP without real DNS.
