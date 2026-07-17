# Cogeto mail

The receive-only inbound SMTP server for a Cogeto instance: a Haraka server that
accepts forwarded mail for the instance's unique inbound address and hands each
message to the app over an internal authenticated endpoint. Part of the Cogeto
stack (see `cogeto/cogeto`). AGPLv3.

It never sends mail (outbound is disabled). It authenticates the sender (SPF),
accepts only the instance's configured recipient address, applies size and
per-host connection limits, and offers STARTTLS when a certificate is mounted. A
customer instance is pull-only and never builds this locally.

## Supported tags

- `X.Y.Z` — an immutable release (for example `1.0.3`). Pin to this in production.
- `latest` — the most recent release.

Use the same version across the three stack images: `cogeto/cogeto`,
`cogeto/cogeto-edge`, and `cogeto/cogeto-mail`.

## Running it

You do not run this image by hand. The operator script installs the whole stack
and prints the DNS records (MX, reverse DNS) the inbound address needs; see the
operator runbook in the repository.

## Verifying the image

Signed with keyless cosign (Sigstore, GitHub OIDC). Verify before trusting a pull:

```sh
cosign verify cogeto/cogeto-mail:1.0.3 \
  --certificate-identity-regexp '^https://github.com/Cogeto/cogeto/\.github/workflows/release\.yml@refs/tags/' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

## Links

- Source and docs: https://github.com/Cogeto/cogeto
- License: AGPL-3.0-only
- Contact: hi@cogeto.eu
