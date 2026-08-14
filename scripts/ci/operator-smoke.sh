#!/usr/bin/env bash
# operator-smoke.sh — run the operator script against a REAL stack, in CI.
#
# WHY THIS EXISTS. The deployment-readiness audit recorded that every required
# check was green while `cogeto upgrade` took an instance down, and that three
# separate operator-tooling defects survived CI for the same reason: the
# invariant suites cover the application, and NOTHING exercised
# scripts/operator/cogeto against a real database and a real stack. The three:
#
#   F1  upgrade never backfilled COGETO_MASTER_KEY, so every upgrade crash-looped
#   F2  `cogeto status` reported the model configuration from .env, which by then
#       held none — it reported a configuration that did not exist
#   F3  `features enable local-models` wrote a variable nothing reads
#
# Two of the three are not "incomplete tooling", they are tooling that LIES.
# So the assertions below are grouped around exactly that: what the script
# PRINTS must be performable, and what it REPORTS must be observed rather than
# read back out of the file it just wrote.
#
# WHAT IT DOES NOT COVER, and cannot from a CI runner. Stated here rather than
# implied away, because a smoke test that reads as full coverage is its own
# version of the problem this fixes:
#
#   • DNS. No zone is edited and no record resolves, so the whole
#     "after DNS propagates" half of the checklist is asserted as TEXT only.
#   • Certificate issuance. Let's Encrypt cannot issue for the smoke domain, so
#     `status` is expected to report NOT GREEN on TLS — that expectation is
#     itself asserted, because a status that went green here would be lying.
#   • Real mail delivery. No MX, no port 25 from the internet, no sender.
#     The mail capability's own enable path is exercised nowhere here; it needs
#     a published mail image and an internet-facing listener.
#   • The supply chain. `install` normally resolves a release through the GitHub
#     and Docker Hub APIs, fetches five deployment assets pinned to the tag's
#     commit, verifies each against a checksum manifest, and refuses to start an
#     image whose cosign signature does not verify. None of that can run against
#     an unpublished commit, so those five functions are replaced by the harness
#     (see `stub_the_outside_world`) and the assets are copied from the working
#     tree. The fetch-and-verify chain is covered by review, not by this test.
#   • A cloud provider's console: backups, network firewall, reverse DNS.
#   • An upgrade between two published releases. What IS covered is the defect
#     class that made upgrade dangerous: the secret backfill, asserted directly
#     against the function.
#
# MODES.
#   --fast   No Docker, no stack: the dry-run install, the printed-checklist and
#            no-retired-mechanism assertions, and the secret-backfill unit
#            checks. Seconds. Runs on every pull request.
#   --full   Everything above plus a real stack from empty volumes: install,
#            status against the running containers, the capability list against
#            the live health surface, enable/disable of an optional capability,
#            and the empty-secret refusal. Minutes. Runs on merges to main.
#
# The images must already be built and tagged as cogeto/cogeto:$COGETO_VERSION
# and cogeto/cogeto-edge:$COGETO_VERSION for --full; the workflow does that.
#
# Runs as root (it creates a service user and an instance directory), so CI
# invokes it under sudo.

set -euo pipefail

MODE="fast"
[ "${1:-}" = "--full" ] && MODE="full"
[ "${1:-}" = "--fast" ] && MODE="fast"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OPERATOR="$REPO_ROOT/scripts/operator/cogeto"
# ISOLATION, and it is not a nicety. Both compose files carry `name: cogeto`,
# so a plain `docker compose --project-directory <tmp>` joins the project a
# developer's own stack is already running under, and this harness's teardown
# (`down -v`) then deletes THAT stack's data volumes. It happened once, on a
# developer box, and cost a working dev instance. Every compose call below goes
# through `smoke_compose`, which pins this project name; nothing here may call
# `docker compose` without it.
SMOKE_PROJECT="cogeto-operator-smoke"
SMOKE_VERSION="${COGETO_VERSION:-0.0.0}"
SMOKE_DOMAIN="smoke.cogeto.invalid"
WORK="$(mktemp -d)"
export COGETO_ROOT="$WORK/srv"
LOGS="$WORK/logs"
mkdir -p "$LOGS"
# The stack is far below the production minimum on a CI runner; the check warns
# instead of dying when this is set, which is the documented override.
export COGETO_SKIP_RESOURCE_CHECK=1
export SMOKE_PROJECT

FAILURES=0
note()  { printf '\n\033[1m── %s\033[0m\n' "$*"; }
pass()  { printf '   ok   %s\n' "$*"; }
fail()  { printf '   FAIL %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }

assert_contains() {  # assert_contains FILE NEEDLE DESCRIPTION
  if grep -qF -- "$2" "$1"; then pass "$3"; else
    fail "$3 (expected to find: $2, in $1)"
  fi
}

assert_absent() {  # assert_absent FILE NEEDLE DESCRIPTION
  if grep -qF -- "$2" "$1"; then
    fail "$3 (found: $2, in $1)"
    grep -nF -- "$2" "$1" | head -3 >&2
  else pass "$3"; fi
}

# ── The outside world ────────────────────────────────────────────────────────
#
# Everything replaced here is a network or supply-chain call that cannot succeed
# against an unpublished commit. Each one is listed in the "does not cover"
# block at the top of this file; nothing else about the script is replaced, and
# in particular secret generation, .env handling, the compose calls, the health
# reads, the checklist and every subcommand's own logic run for real.
stub_the_outside_world() {
  resolve_latest_version()    { printf '%s' "$SMOKE_VERSION"; }
  github_latest_version()     { printf '%s' "$SMOKE_VERSION"; }
  hub_latest_version()        { printf '%s' "$SMOKE_VERSION"; }
  hub_tag_exists()            { return 0; }
  require_supported_version() { say "[smoke] release v$1 assumed published (registry lookups are not exercised)"; }
  install_docker()            { say "[smoke] Docker is already installed on the runner"; }
  install_cosign()            { say "[smoke] cosign install skipped (unpublished images cannot be verified)"; }
  verify_images()             { say "[smoke] image signature verification skipped (unpublished images)"; }
  # $0 is this harness when the operator script is SOURCED, so the real
  # install_self would copy the wrong file onto PATH.
  install_self()              { say "[smoke] self-install skipped"; }
  # A developer box (macOS) has no useradd; CI does, and there it runs for real.
  command -v useradd >/dev/null 2>&1 || ensure_service_user() {
    say "[smoke] service-user creation skipped (no useradd on this host)"
  }
  # CI runs this under sudo, so the root requirement is exercised there. A
  # developer running it against their own Docker is not root, and saying so is
  # better than not running the rest.
  if [ "$(id -u)" -ne 0 ]; then
    require_root() { warn "[smoke] not running as root: the root requirement is NOT exercised in this run"; }
  fi
  # Same shape: the supported-OS check is real on the Ubuntu runner and cannot
  # pass on a developer's macOS box.
  if [ ! -f /etc/os-release ]; then
    check_os() { warn "[smoke] no /etc/os-release: the supported-OS check is NOT exercised in this run"; }
  fi
  detect_public_ip()          { printf '203.0.113.10'; }
  # The five deployment assets, copied from the working tree instead of fetched
  # at the release commit and checksum-verified. This is the change under test:
  # a fetch would install the LAST RELEASE's compose file, not this one.
  fetch_deploy_assets() {
    say "[smoke] staging the deployment assets from the working tree (no fetch, no checksum verification)"
    run mkdir -p "$COGETO_ROOT/zitadel-init" "$COGETO_ROOT/postgres-init" "$COGETO_ROOT/searxng"
    run cp "$REPO_ROOT/project/infra/deploy/docker-compose.deploy.yml" "$COGETO_ROOT/docker-compose.yml"
    run cp "$REPO_ROOT/project/infra/deploy/Caddyfile" "$COGETO_ROOT/Caddyfile"
    run cp "$REPO_ROOT/project/infra/docker/zitadel-init/init.mjs" "$COGETO_ROOT/zitadel-init/init.mjs"
    run cp "$REPO_ROOT/project/infra/docker/postgres-init/db-init.sql" "$COGETO_ROOT/postgres-init/db-init.sql"
    run cp "$REPO_ROOT/project/infra/docker/searxng/settings.yml" "$COGETO_ROOT/searxng/settings.yml"
    # Developer convenience, never set in CI: a compose override staged beside
    # the deployment files, which compose merges automatically. The intended
    # use is host-port remapping on a machine where 80/443 are already taken,
    # so a developer can run --full beside a dev stack. Anything it changes is
    # NOT what CI exercises, so keep it to ports.
    if [ -n "${COGETO_SMOKE_COMPOSE_OVERRIDE:-}" ]; then
      warn "staging a compose override from ${COGETO_SMOKE_COMPOSE_OVERRIDE} — this run does not exercise the file as CI does"
      run cp "$COGETO_SMOKE_COMPOSE_OVERRIDE" "$COGETO_ROOT/docker-compose.override.yml"
    fi
  }
  # `compose pull` would go to Docker Hub for a tag that does not exist there.
  # Every other compose call is real.
  compose() {
    if [ "${1:-}" = "pull" ]; then
      say "[smoke] compose pull skipped (the images are built locally)"
      return 0
    fi
    docker compose --project-name "$SMOKE_PROJECT" --project-directory "$COGETO_ROOT" "$@"
  }
}

# The harness's own compose calls. Same pinned project name as the override
# above: this is the only way this script may reach Docker.
smoke_compose() { docker compose --project-name "$SMOKE_PROJECT" --project-directory "$COGETO_ROOT" "$@"; }

# One operator run, in its own subshell, exactly like one CLI invocation: the
# checklist accumulators start empty every time.
operator() {  # operator LOGNAME ARGS...
  local logname="$1"; shift
  set +e
  (
    # shellcheck disable=SC1090
    . "$OPERATOR"
    stub_the_outside_world
    main "$@"
  ) </dev/null >"$LOGS/$logname.txt" 2>&1
  local status=$?
  set -e
  cat "$LOGS/$logname.txt"
  return $status
}

# `install` asks for a typed y/N before it touches anything.
operator_install() {
  set +e
  (
    # shellcheck disable=SC1090
    . "$OPERATOR"
    stub_the_outside_world
    main install --domain "$SMOKE_DOMAIN" --acme-email "ops@cogeto.invalid" --version "$SMOKE_VERSION"
  ) <<<"y" >"$LOGS/install.txt" 2>&1
  local status=$?
  set -e
  cat "$LOGS/install.txt"
  return $status
}

# ── Assertions that need no stack ────────────────────────────────────────────

# A mechanism this system no longer has. An operator who follows one of these
# does nothing and cannot tell — the F2/F3 failure mode, which is worse than a
# missing instruction because it looks like a completed step.
RETIRED_MECHANISMS=(
  '--mistral-key'
  'MISTRAL_API_KEY'
  'COGETO_PROVIDER_PRESET'
  'features enable local-models'
  'compose exec worker npm run reindex'
  'compose exec -T worker npm run reindex'
  'approval queue'
  'COGETO_OLLAMA_TIMEOUT'
)

assert_no_retired_mechanism() {  # assert_no_retired_mechanism FILE LABEL
  local file="$1" label="$2" found=0
  for mechanism in "${RETIRED_MECHANISMS[@]}"; do
    if grep -qF -- "$mechanism" "$file"; then
      fail "$label references a retired mechanism: $mechanism"
      found=1
    fi
  done
  [ "$found" -eq 0 ] && pass "$label references no retired mechanism"
}

check_dry_run_install() {
  note "dry-run install: the printed checklist"
  operator dry-install --check install --domain "$SMOKE_DOMAIN" --acme-email ops@cogeto.invalid \
    --version "$SMOKE_VERSION" >/dev/null || fail "--check install exited non-zero"
  local log="$LOGS/dry-install.txt"

  assert_contains "$log" 'WHAT YOU MUST DO NOW' 'the run ends with the operator checklist'
  assert_contains "$log" "app A record:      ${SMOKE_DOMAIN}." 'the checklist names the app A record with the real domain'
  assert_contains "$log" "s3.${SMOKE_DOMAIN}." 'the checklist names the presign-origin A record'
  assert_contains "$log" 'Automated Backup' 'the checklist names the backup the script cannot enable itself'
  assert_contains "$log" 'operator vault' 'the checklist names the vault step'
  # The step that replaced the dead model-key step (F2). It must name the place
  # the configuration actually lives.
  assert_contains "$log" 'Providers (left rail)' 'the checklist routes model configuration to the interface'
  assert_contains "$log" 'no restart is needed after' 'the checklist states that the model change needs no restart'
  # Mail is off on a fresh install (SEC-14), so the MX/PTR steps must NOT be
  # printed: an instruction for a listener that is not running is the same
  # class of defect.
  assert_contains "$log" 'Email capture is OFF on this instance' 'the checklist says email capture is off'
  assert_absent "$log" 'IN MX 10' 'no MX step is printed while inbound mail is off'
  assert_absent "$log" 'set the PTR' 'no PTR step is printed while inbound mail is off'
  assert_no_retired_mechanism "$log" 'the install checklist'
}

check_secret_backfill() {
  # The F1 defect class, asserted against the function that fixes it: an
  # instance whose .env predates a secret must GET that secret on upgrade, and
  # an existing secret must never be rotated by the backfill.
  note "upgrade secret backfill (the F1 defect class)"
  local root="$WORK/backfill"
  mkdir -p "$root"
  (
    export COGETO_ROOT="$root"
    # shellcheck disable=SC1090
    . "$OPERATOR"
    ENV_FILE="$COGETO_ROOT/.env"
    printf 'COGETO_VERSION=1.0.0\nCOGETO_APP_DB_PASSWORD=already-set-do-not-touch\n' >"$ENV_FILE"
    ensure_wave3_secrets
    printf 'MASTER_KEY=%s\n' "$(env_get COGETO_MASTER_KEY)" >"$root/report"
    printf 'APP_DB=%s\n' "$(env_get COGETO_APP_DB_PASSWORD)" >>"$root/report"
    printf 'MIGRATE_DB=%s\n' "$(env_get COGETO_MIGRATE_DB_PASSWORD)" >>"$root/report"
    printf 'S3=%s\n' "$(env_get COGETO_S3_SECRET_KEY)" >>"$root/report"
  )
  if grep -q '^MASTER_KEY=.\{20,\}$' "$root/report"; then
    pass 'a missing COGETO_MASTER_KEY is backfilled on upgrade'
  else
    fail 'COGETO_MASTER_KEY was NOT backfilled — this is exactly F1'
  fi
  assert_contains "$root/report" 'APP_DB=already-set-do-not-touch' 'an existing secret is never rotated by the backfill'
  grep -q '^MIGRATE_DB=.\{20,\}$' "$root/report" \
    && pass 'the migration role password is backfilled' \
    || fail 'COGETO_MIGRATE_DB_PASSWORD was not backfilled'
  grep -q '^S3=.\{20,\}$' "$root/report" \
    && pass 'the scoped S3 secret is backfilled' \
    || fail 'COGETO_S3_SECRET_KEY was not backfilled'
}

# ── Assertions that need the stack ───────────────────────────────────────────

# Every variable the deploy compose REQUIRES (`${VAR:?}`), derived from the file
# itself so the list cannot drift away from what compose actually demands.
required_secrets() {
  # Comment lines are skipped: the file's own header explains the `${VAR:?}`
  # convention, and a documentation example is not a required variable.
  grep -v '^[[:space:]]*#' "$REPO_ROOT/project/infra/deploy/docker-compose.deploy.yml" \
    | grep -oE '\$\{[A-Z_][A-Z0-9_]*:\?' \
    | sed 's/^\${//; s/:?$//' | sort -u
}

check_generated_secrets() {
  note "install generated every secret the deploy compose requires"
  local missing=0 count=0
  while read -r name; do
    [ -z "$name" ] && continue
    count=$((count + 1))
    local value
    value="$(sed -n "s/^${name}=//p" "$COGETO_ROOT/.env" | tail -n 1)"
    if [ -z "$value" ]; then
      fail "required secret ${name} is missing or empty in the generated .env"
      missing=$((missing + 1))
    fi
  done <<<"$(required_secrets)"
  [ "$count" -ge 12 ] || fail "only ${count} required variables found — did the derivation break?"
  [ "$missing" -eq 0 ] && pass "all ${count} required variables are present and non-empty"
  # The file holding every instance secret must not be world-readable.
  local perms
  perms="$(stat -c '%a' "$COGETO_ROOT/.env" 2>/dev/null || stat -f '%Lp' "$COGETO_ROOT/.env")"
  [ "$perms" = "600" ] && pass '.env is mode 600' || fail ".env is mode ${perms}, expected 600"
  # No model configuration in .env, ever again (the F2/F3 root cause).
  assert_absent "$COGETO_ROOT/.env" 'MISTRAL' '.env carries no model configuration'
  assert_absent "$COGETO_ROOT/.env" 'COGETO_MODEL_PIPELINE' '.env carries no model assignment'
}

check_status_is_observed() {
  note "status reports what is running, not what .env says"
  operator status status || true   # NOT GREEN is the expected verdict here
  local log="$LOGS/status.txt"

  assert_contains "$log" "configured version : v${SMOKE_VERSION}" 'status prints the configured version'
  assert_contains "$log" "running image      : cogeto/cogeto:${SMOKE_VERSION}" \
    'status prints the image the app container is ACTUALLY running'
  assert_contains "$log" 'app        healthy' 'status reports the app container healthy'
  assert_contains "$log" 'worker     healthy' 'status reports the worker container healthy'
  # F2, the assertion that matters most: no provider is configured on a fresh
  # instance, and status must say so rather than infer a configuration from the
  # environment file it just wrote.
  assert_contains "$log" 'NOT CONFIGURED' 'status reports the model provider as not configured'
  assert_absent "$log" 'model provider     = ' 'status does not read the model provider from .env'
  # And it must not green-wash: no certificate can be issued for the smoke
  # domain, so the honest verdict is NOT GREEN.
  assert_contains "$log" 'VERDICT: NOT GREEN' 'status refuses to report green while TLS is not working'
  assert_no_retired_mechanism "$log" 'the status report'

  note "status reflects a container that is actually down"
  smoke_compose stop worker >/dev/null 2>&1
  operator status-degraded status || true
  assert_absent "$LOGS/status-degraded.txt" 'worker     healthy' \
    'status does not report a stopped worker as healthy'
  smoke_compose start worker >/dev/null 2>&1
}

# The capability ids the running app reports, one per line.
live_capability_ids() {
  smoke_compose exec -T app node -e '
    fetch("http://127.0.0.1:3000/api/health")
      .then((r) => r.json())
      .then((j) => { for (const c of j.capabilities ?? []) console.log(c.id); })
      .catch(() => process.exit(1));
  ' 2>/dev/null | tr -d '\r' | sort
}

check_features_match_health() {
  note "the features list matches the capability registry"
  operator features features || fail 'features exited non-zero'
  local live script
  live="$(live_capability_ids)"
  script="$(
    # shellcheck disable=SC1090
    . "$OPERATOR"
    printf '%s %s' "$FEATURE_IDS" "$FEATURE_IDS_REPORTED_ONLY" | tr ' ' '\n' | grep -v '^$' | sort
  )"
  if [ "$live" = "$script" ]; then
    pass "the script knows exactly the $(printf '%s' "$live" | grep -c .) capabilities health reports"
  else
    fail 'the script and the health surface disagree about the capability set'
    diff <(printf '%s\n' "$script") <(printf '%s\n' "$live") >&2 || true
  fi
  # Every capability the script does not switch must still say where it IS
  # decided, or an operator reads it as broken (F15).
  while read -r id; do
    [ -z "$id" ] && continue
    assert_contains "$LOGS/features.txt" "$id" "features lists the ${id} capability"
  done <<<"$live"
  assert_no_retired_mechanism "$LOGS/features.txt" 'the features listing'
}

check_optional_capability() {
  note "enable and disable an optional capability (research)"
  operator enable-research features enable research || fail 'features enable research failed'
  local profiles secret
  profiles="$(sed -n 's/^COMPOSE_PROFILES=//p' "$COGETO_ROOT/.env" | tail -n 1)"
  case ",$profiles," in *,research,*) pass 'the research profile is recorded in .env' ;;
    *) fail "COMPOSE_PROFILES is '${profiles}' after enabling research" ;; esac
  secret="$(sed -n 's/^SEARXNG_SECRET=//p' "$COGETO_ROOT/.env" | tail -n 1)"
  [ ${#secret} -ge 32 ] && pass 'enabling research generated a real session secret' \
    || fail "SEARXNG_SECRET is ${#secret} characters after enabling research"
  smoke_compose --profile research ps searxng | grep -q searxng \
    && pass 'the searxng container is running' || fail 'the searxng container is not running'

  note "the empty-secret refusal (audit F12)"
  # An operator who edits COMPOSE_PROFILES by hand gets no generated secret.
  # With the profile ACTIVE and the secret empty, the preflight must refuse.
  cp "$COGETO_ROOT/.env" "$WORK/env.backup"
  # Portable in-place edit: `sed -i` takes a suffix on BSD and not on GNU.
  grep -v '^SEARXNG_SECRET=' "$WORK/env.backup" >"$COGETO_ROOT/.env"
  printf 'SEARXNG_SECRET=\n' >>"$COGETO_ROOT/.env"
  if smoke_compose run --rm -T preflight >"$LOGS/preflight-empty.txt" 2>&1; then
    fail 'the preflight ACCEPTED an active research profile with an empty secret'
  else
    assert_contains "$LOGS/preflight-empty.txt" 'SEARXNG_SECRET' 'the preflight refuses and names the empty secret'
  fi
  cp "$WORK/env.backup" "$COGETO_ROOT/.env"

  operator disable-research features disable research || fail 'features disable research failed'
  profiles="$(sed -n 's/^COMPOSE_PROFILES=//p' "$COGETO_ROOT/.env" | tail -n 1)"
  case ",$profiles," in *,research,*) fail 'the research profile survived disabling' ;;
    *) pass 'the research profile is gone from .env' ;; esac
  if smoke_compose --profile research ps --status running searxng 2>/dev/null | grep -q searxng; then
    fail 'the searxng container is still running after disable'
  else
    pass 'the searxng container is stopped'
  fi
}

teardown() {
  note "teardown"
  # Belt and braces on the isolation above: this removes VOLUMES, so it refuses
  # to run against any project but its own.
  case "$SMOKE_PROJECT" in
    cogeto | cogeto-dev | '')
      fail "refusing to tear down: SMOKE_PROJECT is '${SMOKE_PROJECT}', which is not this harness's own project"
      return 0
      ;;
  esac
  smoke_compose --profile research --profile mail --profile redaction \
    down -v --remove-orphans >/dev/null 2>&1 || true
  pass 'stack removed'
}

# ── Run ──────────────────────────────────────────────────────────────────────

printf 'operator smoke: mode=%s version=%s root=%s\n' "$MODE" "$SMOKE_VERSION" "$COGETO_ROOT"

check_dry_run_install
check_secret_backfill

if [ "$MODE" = "full" ]; then
  trap teardown EXIT
  note "install onto a real stack from empty volumes"
  operator_install || fail 'install exited non-zero'
  assert_contains "$LOGS/install.txt" 'stack healthy' 'the stack reached health during install'
  assert_no_retired_mechanism "$LOGS/install.txt" 'the install run'
  check_generated_secrets
  check_status_is_observed
  check_features_match_health
  check_optional_capability
fi

note "result"
if [ "$FAILURES" -eq 0 ]; then
  printf 'operator smoke (%s): every assertion held\n' "$MODE"
else
  printf 'operator smoke (%s): %d assertion(s) failed\n' "$MODE" "$FAILURES" >&2
  exit 1
fi
