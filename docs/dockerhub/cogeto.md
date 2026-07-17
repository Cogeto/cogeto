# Cogeto

Private, EU-hosted AI memory you can inspect, correct, and provably delete. Every
trust claim is backed by an inspectable artifact. AGPLv3.

This is the main application image: it runs the Cogeto app, the background worker,
and the one-shot migrate and preflight jobs (the same image, started with
different commands). A customer instance is pull-only and never builds locally.

## Supported tags

- `X.Y.Z` — an immutable release (for example `1.0.3`). Pin to this in production.
- `latest` — the most recent release.

The full stack a customer instance runs is three images at the same version:
`cogeto/cogeto`, `cogeto/cogeto-edge` (the Caddy edge with the built web app), and
`cogeto/cogeto-mail` (the receive-only inbound SMTP server).

## Running it

You do not run this image by hand. A single operator script installs a full
instance on a fresh Ubuntu host, generating per-tenant secrets and pulling this
signed image. See the deployment guide and operator runbook in the repository.

## Verifying the image

Every release image is signed with keyless cosign (Sigstore, GitHub OIDC). Verify
before you trust a pulled image:

```sh
cosign verify cogeto/cogeto:1.0.3 \
  --certificate-identity-regexp '^https://github.com/Cogeto/cogeto/\.github/workflows/release\.yml@refs/tags/' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

An SPDX SBOM is attached to each GitHub Release and as a cosign attestation.

## Links

- Source and docs: https://github.com/Cogeto/cogeto
- License: AGPL-3.0-only
- Contact: hi@cogeto.eu
