# Image & model pins — update procedure (QS-25)

All container base images are pinned **by digest** and the redaction sidecar's
spaCy NER model is pinned **by exact version**, so builds are reproducible and
cannot silently drift under a floating tag (audit finding QS-25). The
human-readable tag is kept in a comment next to each digest.

## Where the pins live

| File | Pinned artifacts |
|---|---|
| `project/infra/docker/Dockerfile` | `node:22-alpine` (deps/build/runtime), `caddy:2-alpine` (edge + consoles) |
| `docker-compose.yml` | `postgres:17-alpine`, `qdrant/qdrant:v1.18.3`, `minio/minio`, `minio/mc`, `busybox:stable`, `ghcr.io/zitadel/zitadel:v2.65.1`, `node:22-alpine` (zitadel-init) |
| `project/services/redaction/Dockerfile` | `python:3.12-slim`, `en_core_web_lg-3.7.1` (spaCy model wheel) |

The static test `project/src/entrypoints/deployment-hardening.spec.ts` fails CI
if any `image:` line is not a digest, or if the spaCy model reverts to an
unpinned download.

## Updating an image pin

1. Resolve the new digest for the tag you want (no pull needed):

   ```sh
   docker buildx imagetools inspect <image>:<tag> | grep -i '^Digest:'
   # or, for an image already pulled locally:
   docker inspect --format '{{index .RepoDigests 0}}' <image>:<tag>
   ```

2. Replace the `@sha256:…` in the relevant file, keeping the `# <image>:<tag>`
   comment in sync so the next reader knows which tag the digest represents.

3. Rebuild and run the suite + a `docker compose up` smoke:

   ```sh
   npm run build && npm test
   docker compose build && docker compose up   # reaches login
   ```

## Updating the spaCy model

The model wheel is installed from a pinned GitHub release URL in
`project/services/redaction/Dockerfile`:

```
pip install https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-3.7.1/en_core_web_lg-3.7.1-py3-none-any.whl
```

To move to a new model version, pick a release compatible with the pinned
`spacy` version in `requirements.txt` (spaCy 3.7.x ↔ model 3.7.x), update the
URL, and rebuild the `redaction` profile. To trade accuracy for ~half the RSS,
pin `en_core_web_md-3.7.1` instead and set `SPACY_MODEL=en_core_web_md`.

## Regenerating the redaction sidecar dependency lock (SEC-12)

`project/services/redaction/requirements.txt` holds the human-readable top-level
pins; `requirements.lock` is the fully hash-locked transitive tree the Dockerfile
installs from with `pip install --require-hashes`. When you change a pin in
`requirements.txt`, regenerate the lock **in the target Python runtime** (3.12,
matching the base image — do not compile on the host, whose Python version pins
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

## Note on remaining `npm audit` advisories

`multer` (QS-12) is pinned to the patched `2.2.0` line via a root `overrides`
entry. The remaining `npm audit` items (`undici`, `drizzle-orm`, `uuid`) were
assessed low-reachability in the audit and require breaking major bumps; they
are tracked separately and out of scope for FIX-2.
