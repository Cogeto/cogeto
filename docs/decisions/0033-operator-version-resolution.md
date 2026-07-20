# 0033 — Operator version policy via GitHub release flags; mandatory image verification

Date: 2026-07-20. Status: accepted. Revises parts of decision 0030 (the
operator script's pinned `DEFAULT_VERSION` / `MIN_VERSION` constants).

## Context

The operator script pinned a "known-good" release in a `DEFAULT_VERSION`
constant that had to be bumped by hand in every release PR, and a
`MIN_VERSION` floor that only encoded a technical limit (first release with
edge/mail images), not the product decision of which releases customers
should be able to install. The pre-launch testing releases (v0.1.1–v1.0.3)
remained installable. Signature verification ran only when cosign happened
to be present; a failed cosign download degraded to a warning.

## Decision

1. **GitHub Releases are the single version-policy lever.** The newest
   release NOT flagged "pre-release" is what `install` and `upgrade latest`
   resolve to (GitHub's `/releases/latest` endpoint applies that filter
   itself). Flagging a release as pre-release retires it: the script refuses
   to install or upgrade to it, with a message naming the latest supported
   release. Retiring or blessing a release is a GitHub UI checkbox or
   `gh release edit vX.Y.Z --prerelease` — never a script edit.
2. **No version constants in the script.** `DEFAULT_VERSION` and
   `MIN_VERSION` are removed. The release PR is a one-line `package.json`
   bump. The Docker Hub tag lookup remains only as a network fallback for
   resolving "latest" (tags cannot express retirement) and as the
   published-image existence check.
3. **The operator always sees and confirms the resolved version** before
   anything changes: `install` asks "install Cogeto vX.Y.Z (latest published
   release)?"; `upgrade` shows current → target with the same labeling plus
   the existing typed confirmation.
4. **Image signature verification is mandatory and fail-closed.** Both
   `install` and `upgrade` install cosign (pinned version) if missing and
   refuse to continue when it cannot be installed or when any of the three
   images fails `cosign verify`. The previous behavior (warn and continue
   without verification) is removed.
5. **Upgrades require a typed backup acknowledgment** (`BACKED-UP`) before
   any mutation: database migrations are forward-only, so the only full
   rollback is the rehearsed backup restore (runbook §5).

The pre-launch releases v0.1.1 through v1.0.3 were flagged pre-release on
2026-07-20; v1.0.4 is the oldest supported release.

## Consequences

- Fresh installs always get the latest blessed release; a bad release is
  withdrawn from the install path in seconds without shipping anything.
- The API dependency is GitHub's anonymous REST API over TLS (1–2 calls per
  run, well under the rate limit), parsed with sed — no new tooling on the
  instance (no gh, no jq, no npm).
- If the GitHub API is unreachable: "latest" falls back to Docker Hub;
  explicit versions fail closed (except in `--check` dry runs, which warn).
- An instance can no longer be started on unverified images by accident;
  the supply-chain guarantee moved from "verifiable" to "verified".
