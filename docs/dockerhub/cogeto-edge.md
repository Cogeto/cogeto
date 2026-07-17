# Cogeto edge

The TLS edge for a Cogeto instance: a Caddy server that carries the prebuilt
single-page web app and reverse-proxies the API and identity provider. Part of
the Cogeto stack (see `cogeto/cogeto`). AGPLv3.

Caddy obtains and renews a real Let's Encrypt certificate automatically once the
instance's DNS points at the host, and serves the web app under a strict Content
Security Policy. A customer instance is pull-only and never builds this locally.

## Supported tags

- `X.Y.Z` — an immutable release (for example `1.0.3`). Pin to this in production.
- `latest` — the most recent release.

Use the same version across the three stack images: `cogeto/cogeto`,
`cogeto/cogeto-edge`, and `cogeto/cogeto-mail`.

## Running it

You do not run this image by hand. The operator script installs the whole stack;
see the deployment guide and operator runbook in the repository.

## Verifying the image

Signed with keyless cosign (Sigstore, GitHub OIDC). Verify before trusting a pull:

```sh
cosign verify cogeto/cogeto-edge:1.0.3 \
  --certificate-identity-regexp '^https://github.com/Cogeto/cogeto/\.github/workflows/release\.yml@refs/tags/' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

## Links

- Source and docs: https://github.com/Cogeto/cogeto
- License: AGPL-3.0-only
- Contact: hi@cogeto.eu
