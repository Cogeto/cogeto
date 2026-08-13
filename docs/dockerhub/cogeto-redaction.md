# Cogeto redaction

The local PII redaction sidecar for a Cogeto instance: a stateless, CPU-only
Presidio/spaCy service that pseudonymizes recognized personal entities in every
outbound model request and re-identifies them in the response, so personal data
never reaches an external model provider. Part of the Cogeto stack (see
`cogeto/cogeto`). AGPLv3.

Optional, and off by default. When it is on, the model gateway **fails closed**:
if this service is unreachable, the call fails rather than sending plaintext.
It holds no state, has no database, publishes no port outside the instance's
internal network, and is the only Python in the stack.

## Supported tags

- `X.Y.Z`: an immutable release (for example `1.6.0`). Pin to this in production.
- `latest`: the most recent release.

Use the same version across the four stack images: `cogeto/cogeto`,
`cogeto/cogeto-edge`, `cogeto/cogeto-mail`, and `cogeto/cogeto-redaction`.

## Running it

You do not run this image by hand. On a Cogeto instance the operator turns the
capability on with `sudo cogeto features enable redaction`, which pulls and
verifies this image, starts it behind the `redaction` compose profile and sets
the fail-closed posture. It holds roughly 0.7 to 1 GB of memory for the NER
model, and it changes retrieval quality, so read the data-sovereignty document
in the repository before enabling it.

## Verifying the image

Signed with keyless cosign (Sigstore, GitHub OIDC), with an SPDX SBOM attached
as an attestation. Verify before trusting a pull:

```sh
cosign verify cogeto/cogeto-redaction:1.6.0 \
  --certificate-identity-regexp '^https://github.com/Cogeto/cogeto/\.github/workflows/release\.yml@refs/tags/' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

## Links

- Source and docs: https://github.com/Cogeto/cogeto
- License: AGPL-3.0-only
- Contact: hi@cogeto.eu
