#!/usr/bin/env bash
# create-issues.sh — create the logically separated GitHub issues for one unit
# of work, under a shared label, idempotently.
#
# Every session opens issues for its unit of work before branching (see
# docs/engineering-workflow.md). This helper makes that repeatable: it creates
# one issue per line of an issue spec, tags them all with a shared label so the
# unit is easy to find and filter on the board, and is SAFE TO RE-RUN — an issue
# whose title already exists (open or closed) is skipped, not duplicated.
#
# Usage:
#   scripts/dev/create-issues.sh <shared-label> <spec-file>
#   scripts/dev/create-issues.sh <shared-label> -   # read the spec from stdin
#
# Spec format — one issue per line, `title | body`  (the body is optional):
#   O4 email: Haraka container in the compose stack | Receive-only SMTP...
#   O4 email: inbound parsing into the pipeline | Headers, body, attachments...
#   O4 email: deletion saga covers email sources
#
# Lines that are blank or start with `#` are ignored. The shared label and any
# per-issue type labels are created if missing.
#
# Environment:
#   REPO       target repo (default: the current directory's origin, via gh)
#   DRY_RUN=1  print what would happen; create nothing
#   ASSIGNEE   optional GitHub login to assign every created issue to
#
# Requires: gh (authenticated as the owner).
set -euo pipefail

die() {
  echo "create-issues.sh: $*" >&2
  exit 1
}

command -v gh >/dev/null 2>&1 || die "gh CLI not found on PATH"

[ "$#" -eq 2 ] || die "usage: create-issues.sh <shared-label> <spec-file|->"

SHARED_LABEL="$1"
SPEC="$2"
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
DRY_RUN="${DRY_RUN:-0}"

echo "Repo:         $REPO"
echo "Shared label: $SHARED_LABEL"
[ "$DRY_RUN" = "1" ] && echo "Mode:         DRY RUN (no changes)"
echo

# Ensure a label exists (idempotent). gh label create is a no-op-with-error if
# it exists, so we swallow that.
ensure_label() {
  local name="$1" color="${2:-ededed}"
  [ -z "$name" ] && return 0
  if [ "$DRY_RUN" = "1" ]; then
    echo "  would ensure label: $name"
    return 0
  fi
  gh label create "$name" --repo "$REPO" --color "$color" >/dev/null 2>&1 || true
}

# True if an issue with exactly this title already exists (any state).
issue_exists() {
  local title="$1" count
  count="$(gh issue list --repo "$REPO" --state all --search "in:title \"$title\"" \
    --json title --jq "[.[] | select(.title == \"$title\")] | length" 2>/dev/null || echo 0)"
  [ "${count:-0}" -gt 0 ]
}

ensure_label "$SHARED_LABEL" "5319e7"

if [ "$SPEC" = "-" ]; then
  SPEC=/dev/stdin
else
  [ -f "$SPEC" ] || die "spec file not found: $SPEC"
fi

created=0 skipped=0
while IFS= read -r line || [ -n "$line" ]; do
  # Trim leading/trailing whitespace.
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -z "$line" ] && continue
  case "$line" in \#*) continue ;; esac

  # Split "title | body" on the first pipe.
  if [[ "$line" == *"|"* ]]; then
    title="${line%%|*}"
    body="${line#*|}"
  else
    title="$line"
    body=""
  fi
  title="${title%"${title##*[![:space:]]}"}"
  title="${title#"${title%%[![:space:]]*}"}"
  body="${body#"${body%%[![:space:]]*}"}"

  if issue_exists "$title"; then
    echo "  skip (exists):   $title"
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$DRY_RUN" = "1" ]; then
    echo "  would create:    $title"
    created=$((created + 1))
    continue
  fi

  args=(issue create --repo "$REPO" --title "$title" --label "$SHARED_LABEL")
  [ -n "$body" ] && args+=(--body "$body") || args+=(--body "Part of ${SHARED_LABEL}.")
  [ -n "${ASSIGNEE:-}" ] && args+=(--assignee "$ASSIGNEE")

  url="$(gh "${args[@]}")"
  echo "  created:         $title"
  echo "                   $url"
  created=$((created + 1))
done <"$SPEC"

echo
echo "Done. created=$created skipped=$skipped (label: $SHARED_LABEL)"
