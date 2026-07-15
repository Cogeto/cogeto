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
| Deploy assets consumed at the tag (`project/infra/deploy/`, the zitadel-init script) | the tagged source tree |

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
