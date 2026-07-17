# Release process

Releases are **tag-driven and cut by the maintainer** — CI never tags. The git
tag and `package.json` `version` are the two sources of truth and must agree
(`npm run verify:version` checks any time; there is no VERSION file).

## The flow

1. **The bump PR.** Land a `chore: release vX.Y.Z` pull request that bumps
   `package.json` (`npm version X.Y.Z --no-git-tag-version`) **and** the
   operator script's pinned known-good release (`DEFAULT_VERSION` in
   `scripts/operator/cogeto`). Squash-merge after the five required checks.
2. **The tag.** On the merged `main`:

   ```sh
   git checkout main && git pull
   npm run verify:version        # sanity: prints the version a tag would need
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

3. **The pipeline** ([`release.yml`](../.github/workflows/release.yml)) runs on
   the tag push:
   - re-verifies tag ↔ `package.json` (a mismatch fails before anything is
     published);
   - builds the three production amd64 images and pushes each as `:X.Y.Z` and
     `:latest` to Docker Hub — `cogeto/cogeto` (runtime),
     `cogeto/cogeto-edge` (Caddy + SPA), `cogeto/cogeto-mail` (inbound SMTP);
   - **signs every image with keyless cosign** (Sigstore, GitHub OIDC);
   - generates an **SBOM** (SPDX JSON) for the main image and attaches it as a
     cosign attestation and a release asset;
   - creates the **GitHub Release** with notes auto-generated from the merged
     Conventional-Commit PRs (grouped by type via
     [`.github/release.yml`](../.github/release.yml)) and a footer showing the
     exact `cosign verify` commands.

   Watch it: `gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')`

## What a release publishes

| Artifact | Where |
| --- | --- |
| `cogeto/cogeto:X.Y.Z` (+ `:latest`) | Docker Hub, cosign-signed |
| `cogeto/cogeto-edge:X.Y.Z` (+ `:latest`) | Docker Hub, cosign-signed |
| `cogeto/cogeto-mail:X.Y.Z` (+ `:latest`) | Docker Hub, cosign-signed |
| SBOM (`cogeto-X.Y.Z.sbom.spdx.json`) | cosign attestation + GitHub Release asset |
| Release notes (grouped by feat/fix/docs/chore) | GitHub Release |
| **Trust scores** (`eval/trust-scores/vX.Y.Z.json` + rebuilt `index.json`) | committed to `main` via an auto-merged PR (decision 0032) |
| Deploy assets consumed at the tag (`project/infra/deploy/`, the zitadel-init script) | the tagged source tree |

### Trust scores (decision 0032)

After the images are pushed and the Release exists, the pipeline runs the
live eval + chat suites for the **default model configuration**, emits the
machine-readable quality record (schema:
[`docs/trust-scores-schema/`](trust-scores-schema/)), and lands it on `main`
as an auto-merged `chore: publish trust scores for vX.Y.Z` PR that passes
the full required checks. Release files are **immutable** — the publisher
refuses to overwrite an existing version. The step **never blocks the
release**: on failure it reports loudly with the manual-retry commands. The
**redacted** configuration is maintainer-run and merged in as a second
`--partial` (see the schema README).

## Rules worth restating

- **PR titles are the changelog** — Conventional Commits, because squash-merge
  makes the title the commit on `main`.
- The `eval-gate` runs live on push to `main`; a release should never be cut
  on a red main.
- The oldest installable release is **0.9.0** (the first to publish the edge
  and mail images); the operator script refuses older tags.
- After a release is verified on a real instance, that version is the new
  pinned `DEFAULT_VERSION` — which is why the bump lives in the release PR of
  the *next* cycle.

## Release flow validation

- **2026-07-17 (v1.0.1):** the full tag-driven release flow was exercised
  end-to-end — a change lands via PR, the version bump lands in a `chore: release`
  PR, the owner tags `vX.Y.Z`, and the pipeline publishes the three signed images,
  the GitHub Release, and the trust scores (the trust-scores PR self-merges once
  its checks pass). No manual JSON, no stuck publish.

- **2026-07-17 (v1.0.2):** re-validated after the trust-scores reliability fixes
  (measure-only emit + check-registration race) — the trust scores now emit,
  publish, and self-merge without a manual step, even when a chat coverage case
  dips on a run.

- **2026-07-17 (v1.0.3):** trust-scores publish validated fully hands-off (fresh branch per run → checks trigger → self-merge).
