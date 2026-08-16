# Image and model pins: update procedure

All container base images are pinned **by digest** and the redaction sidecar's
spaCy NER model is pinned **by exact version**, so builds are reproducible and
cannot silently drift under a floating tag. The human-readable tag lives **in
the image reference itself** (`image:tag@sha256:...`, 2026-08 triage): it
cannot be omitted, cannot go stale beside its digest, and is what Dependabot
tracks when proposing updates, so a proposed digest is always a build of the
intended tag and never of `latest`.

## Where the pins live

| File | Pinned artifacts |
|---|---|
| `project/infra/docker/Dockerfile` | `node:24-alpine` (deps/build/runtime), `caddy:2-alpine` (edge + consoles) |
| `docker-compose.yml` | `postgres:17-alpine`, `qdrant/qdrant:v1.19.0`, `cogeto/silo:RELEASE.2026-08-06T00-00-00Z` (the audited MinIO fork under Cogeto custody), `minio/mc:RELEASE.2025-08-13T08-35-41Z`, `busybox:stable`, `ghcr.io/zitadel/zitadel:v4.17.1`, `searxng/searxng` (dated build tag), `node:24-alpine` (zitadel-init) |
| `project/infra/deploy/docker-compose.deploy.yml` | the same upstream images as the dev stack, at the same digests. Cogeto's own four images resolve by release tag (`cogeto/cogeto`, `-edge`, `-mail`, `-redaction` at `${COGETO_VERSION}`) |
| `project/services/mail/Dockerfile` | `node:24-alpine` |
| `project/services/redaction/Dockerfile` | `python:3.12-slim`, `en_core_web_lg-3.8.0` (spaCy model wheel) |

The static test `project/src/entrypoints/deployment-hardening.spec.ts` fails CI
if any `image:` line in EITHER compose file is not a digest, if any Dockerfile
we ship stops pinning its base by digest, if the spaCy model reverts to an
unpinned download, or if a digest is commented with a `:latest` tag that names
no release (audit 2.0 SEC-22/SEC-35).

Recording the real tag matters: a digest pinned as `latest` is unauditable,
because the running version cannot be recovered and so no advisory can be
matched to it. If a tag must be recovered from a digest:

```sh
docker run --rm --entrypoint sh <image>@<digest> -c 'silo --version'
```

## Updating an image pin

1. Resolve the new digest for the tag you want (no pull needed):

 ```sh
 docker buildx imagetools inspect <image>:<tag> | grep -i '^Digest:'
 # or, for an image already pulled locally:
 docker inspect --format '{{index .RepoDigests 0}}' <image>:<tag>
 ```

2. Replace the tag and the `@sha256:…` in the image reference together. The
 `deployment-hardening` spec fails a pin whose reference lacks a real tag.
 A compose change on one side must be mirrored in the other compose file
 (digest parity is tested), and a deploy-compose change needs
 `node scripts/ci/deploy-assets-manifest.mjs --write` in the same commit.

3. Rebuild and run the suite + a `docker compose up` smoke:

 ```sh
 npm run build && npm test
 docker compose build && docker compose up # reaches login
 ```

## Zitadel: Login V1 pinned, Login V2 deferred

Both composes pin new instances to the built-in V1 login
(`ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_REQUIRED: 'false'`); Login V2 is a
separate container (`ghcr.io/zitadel/zitadel-login`, versioned in lockstep
with the core) this stack does not run, and without the pin a fresh install
would 404 at login. V1 is supported for the whole v4 line, so nothing is
urgent; adopt V2 as its own deliberate change **before any Zitadel v5 bump**
(v5 is expected to drop V1). The work, roughly a focused day plus the usual
rehearsal: the login container in both composes, a Caddy route for
`/ui/v2/login`, the core LoginV2/OIDC URL environment (the official Zitadel
compose in `zitadel/zitadel` `deploy/compose/` has the exact lines), and
`zitadel-init` provisioning the permanent `login-client` machine user + PAT
(role `IAM_LOGIN_CLIENT`) for existing instances. Verify hr/de/fr login
translations and that no watermark reappears, and script the Cogeto branding
(logo + colors, from `assets/brand/`) into init in the same change.

## Updating the spaCy model

The model wheel is installed from a pinned GitHub release URL in
`project/services/redaction/Dockerfile`:

```
pip install --no-deps https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-3.8.0/en_core_web_lg-3.8.0-py3-none-any.whl
```

To move to a new model version, pick a release compatible with the pinned
`spacy` version in `requirements.txt` (currently `spacy==3.8.15`, so model
3.8.x), update the URL, and rebuild the `redaction` profile. To trade accuracy
for ~half the RSS, pin `en_core_web_md-3.8.0` instead and set
`SPACY_MODEL=en_core_web_md`.

Note: `presidio-analyzer` pins `spacy != 3.8.14`, so a spacy bump must skip
exactly that version (3.8.15 satisfies it).

## Regenerating the redaction sidecar dependency lock (SEC-12)

`project/services/redaction/requirements.txt` holds the human-readable top-level
pins; `requirements.lock` is the fully hash-locked transitive tree the Dockerfile
installs from with `pip install --require-hashes`. When you change a pin in
`requirements.txt`, regenerate the lock **in the target Python runtime** (3.12,
matching the base image, do not compile on the host, whose Python version pins
different wheels):

```sh
cd project/services/redaction
docker run --rm -v "$PWD/requirements.txt:/work/requirements.txt" -w /work python:3.12-slim \
 bash -c "pip install pip-tools==7.4.1 && \
 pip-compile --generate-hashes --allow-unsafe \
 --output-file=/work/requirements.lock /work/requirements.txt && \
 cat /work/requirements.lock" > requirements.lock
```

`--allow-unsafe` is required so `setuptools` (a runtime dep of spaCy) is pinned +
hashed too; without it `--require-hashes` install fails. Verify before committing:

```sh
docker run --rm -v "$PWD/requirements.lock:/work/requirements.lock:ro" -w /work \
 python:3.12-slim pip install --require-hashes --dry-run -r /work/requirements.lock
```

## Note on `npm audit`

`npm audit` is clean in all three workspaces (2026-08 triage). Two root
`overrides` entries are deliberate and stay: `multer` on the patched `2.2.0`
line, and `uuid` at `^11` inside `exceljs`.
