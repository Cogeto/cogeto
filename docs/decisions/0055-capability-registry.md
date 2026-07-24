# 0055 — The capability registry: observable, controllable, announced

- **Status:** accepted
- **Date:** 2026-07-24
- **Context:** P6.7 (capabilities visibility and control). Optional services
  are compose profiles with invisible state: the owner sometimes does not know
  what is enabled, what is running, or what is silently broken. Nothing in the
  product, the operator script, or the boot log stated the truth in one place.

## Rulings

### 1. One authoritative registry, frozen here

Every optional capability of an instance is an entry in a single registry
(`project/src/entrypoints/capabilities.ts` — a composition-root concern like
the health controller, reading other modules only through their public
interfaces). An entry states: how enablement is determined, how health is
checked, and its failure semantics. The initial set:

| id | enablement | health | failure semantics |
|---|---|---|---|
| `redaction` | `REDACTION_ENABLED` (the same flag the gateway obeys) | GET sidecar `/health` | **fail-closed** (§B.8/QS-21): unreachable → model calls fail, never plaintext |
| `research` | profile `research` in `COGETO_COMPOSE_PROFILES`, or `COGETO_RESEARCH_ENABLED` | GET SearXNG `/healthz` | **degrade-with-message**: the feature answers "search unavailable" |
| `demo` | `COGETO_DEMO_MODE` | passive: the production-guard state (`COGETO_PRODUCTION`) | demo + production → the guard refuses the seed (decision 0022 r4) — a loud misconfiguration |
| `consoles` | profile `consoles` in `COGETO_COMPOSE_PROFILES`, or `COGETO_CONSOLES_ENABLED` | none — enabled/disabled only | the console edge binds to the HOST loopback; the app has nothing it can probe, and says so (`probed: false`) |
| `local-models` | any model tier resolved to the `ollama` provider | the decision-0041 probe (`/api/tags` reachability + required models pulled), reused via `probeLocalRuntime` | **external dependency**: boot refuses; a runtime that dies later goes loud here |

Scheduled jobs join the same surface as a second category: `dreaming`
(dream_run) and `sweep` (the integrity sweep's own ledger), each with last-run
time, last result, and an overdue state.

### 2. States and loudness

Capabilities: `on`, `unreachable` (**loud**), `off`. Jobs: `ok`, `overdue`
(**loud**), `failing` (the newest dream run started > 2 h ago and never
finished — the only error signal `dream_run` carries; a crashed sweep leaves
no record and is caught by `overdue`). **Loud** means all three of: visually
prominent in the Capabilities panel, a named degradation in `/api/health`
(overall status flips to `degraded`), and logged at `warn` on detection (on
the transition, not every poll).

Nothing is inferred silently where it can be checked: enabled capabilities
with a probe are probed every (uncached) read; pure-configuration entries are
reported as such, never guessed at.

### 3. The profile list is passed in; the flags stay authoritative

A container cannot see which compose profiles are active, so the active list
is mirrored in: `COGETO_COMPOSE_PROFILES: ${COMPOSE_PROFILES:-}` in both
compose files. `COMPOSE_PROFILES` in `.env` is the single line the operator
script maintains — compose activates those profiles on a plain `up`, and the
app reads the same value. Where a capability already had an explicit flag
(`REDACTION_ENABLED`, `COGETO_DEMO_MODE`), that flag remains the authority
(it is what the behavior actually follows). CLI `--profile` flags are
invisible to the container; dev one-offs set `COGETO_RESEARCH_ENABLED` /
`COGETO_CONSOLES_ENABLED` instead.

### 4. Thresholds and caching, frozen

- Overdue: no successful run within **26 h** (`COGETO_JOBS_OVERDUE_HOURS`,
  configurable) — one nightly slot (sweep 03:00, dreaming 03:30 UTC) plus
  slack. A job that never ran is quiet until the instance itself (first
  migration's `applied_at`) is older than the threshold, then overdue.
- Registry snapshots are cached **20 s** in-process
  (`CAPABILITY_CACHE_TTL_MS`): probes are cheap but not free and the panel
  polls every 10 s; 20 s keeps "kill the container, watch it go loud" under
  half a minute.

### 5. `/api/health` grows additively

`capabilities: CapabilitySummary[]` and `jobs: ScheduledJobSummary[]` join
`HealthReport` beside the untouched `checks` object (the operator script and
the status panel iterate `checks` — guarded by `health_additive`).

### 6. Control stays in the operator script; the product only observes

`cogeto features [enable|disable <id>]` edits `.env` idempotently
(`COMPOSE_PROFILES` + the capability's flags), applies via
`compose up -d --remove-orphans`, waits for health, and prints operator
TODOs. Disabling redaction and toggling local-models (an embeddings change →
reindex) require typed confirmations; enabling demo on a production instance
is refused loudly. The web application never gains docker-level privilege:
the panel shows the enable command, never a toggle.

### 7. The deploy channel gains exactly one profile: `research`

SearXNG is a digest-pinned upstream image, so it joins the pull-only deploy
compose under `profiles: ['research']` (its `settings.yml` becomes a fetched
deploy asset). Redaction, demo, dev-seed and consoles remain outside the v1
deploy channel (decision 0030 unchanged — their images are never published);
`cogeto features` states that plainly when asked for them on a deployed
instance.

### 8. The boot banner

Every app boot logs one delimited line from the same registry snapshot:
`Capabilities: redaction ON (healthy) | research OFF | ... Jobs: dreaming
last ran 6h ago | sweep last ran 6h ago.` Exact truth, every boot
(`banner_accurate`); a failed banner read is itself stated at warn, never
swallowed.

## Consequences

- Adding a capability = one registry entry (enablement + probe + semantics +
  panel copy) and, if operator-togglable, one `features` case — the process is
  documented in `docs/notes/capabilities.md`.
- Two dev-only web test dependencies (`jsdom`, `axe-core`) were added for the
  `panel_a11y` axe gate the unit's spec requires.
- The `env_set` helper's replace path no longer aborts when the replaced key
  is the only line in `.env` (latent `set -e`/`grep -v` interaction, found by
  the new idempotency test).
