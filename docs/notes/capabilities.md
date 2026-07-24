# Capabilities — the registry, states, thresholds, and how to add one

Developer notes for P6.7 (decision 0055). The registry makes every optional
capability observable in the product (System → Capabilities, `/api/health`),
controllable through the operator script (`cogeto features`), and announced at
boot (the banner). This list will grow — the last section is the recipe.

## Where things live

| Piece | File |
|---|---|
| Registry service + boot-banner formatter | `project/src/entrypoints/capabilities.ts` |
| `/api/health` fields (`capabilities`, `jobs`) | `project/src/entrypoints/health.controller.ts`, types in `project/shared/src/health.ts` |
| Panel + its pure copy model | `project/web/src/components/CapabilitiesPanel.tsx`, `capabilities-model.ts` |
| Operator control | `scripts/operator/cogeto` (`cmd_features`, `features_enable/disable`, profile helpers) |
| Boot banner call site | `project/src/entrypoints/app.ts` (after listen) |
| Tests | `capabilities.spec.ts` (registry_states, jobs_overdue, probe_cached, banner_accurate), `capabilities.integration.spec.ts` (health_additive, real-SQL overdue), `capabilities-panel.spec.tsx` (panel_renders_states, panel_a11y), `operator-script.spec.ts` (features section) |

## The registry (initial set)

Five capabilities — redaction (fail-closed), research (degrade-with-message),
demo (production-guard), consoles (enabled/disabled only), local-models
(external dependency) — and two jobs (dreaming, sweep). The full table with
enablement sources, probes and failure semantics is frozen in decision 0055
and not duplicated here.

States: capabilities `on` / `unreachable` (loud) / `off`; jobs `ok` /
`overdue` (loud) / `failing`. Loud = prominent in the panel + named
degradation in `/api/health` (status `degraded`) + one `warn` log on the
transition.

## Thresholds and cache

- `COGETO_JOBS_OVERDUE_HOURS` (default **26**): no successful run within the
  window → `overdue`. Never-ran jobs are quiet until the instance (min
  `applied_at` in `cogeto_migrations`) is older than the window.
- Stuck-run detection: the newest `dream_run` with `finished_at IS NULL`
  started more than **2 h** ago → `failing` (a crashed sweep leaves no row and
  is caught by `overdue` instead — it has no equivalent signal).
- Snapshot cache: **20 s** (`CAPABILITY_CACHE_TTL_MS`). The panel polls
  `/api/health` every 10 s, so a killed service goes loud within ~30 s.

## Enablement signals

`COMPOSE_PROFILES` in `.env` is the one line that both activates compose
profiles and (mirrored as `COGETO_COMPOSE_PROFILES`) tells the app what is
enabled. `cogeto features enable/disable` maintains it. Existing explicit
flags stay authoritative where behavior follows them (`REDACTION_ENABLED`,
`COGETO_DEMO_MODE`). Dev one-offs with `docker compose --profile ...` are
invisible to the container — set `COGETO_RESEARCH_ENABLED=1` /
`COGETO_CONSOLES_ENABLED=1` for those runs, or put the profile in
`COMPOSE_PROFILES` and drop the CLI flag.

Deploy channel: only the `research` profile ships (SearXNG is digest-pinned
upstream, pull-only; its `settings.yml` is a fetched deploy asset). Redaction,
demo, and consoles are refused there with the reason (decision 0030).

## Follow-up noted, not forced

Loud capability states are NOT yet attention-feed items. The feed is computed
per Principal from user-scoped signals and carries no admin gating today;
injecting instance-level operator alerts would push identity/admin knowledge
into `AttentionService` (a known eval-sensitive constructor — see the P6.6
notes). The System panel + `/api/health` degradation + warn logs cover the
operator today. If the feed later grows an admin lane, add a
`capability_loud` kind mapped from `CapabilitiesService.loudness()`.

## How to add a future capability

1. **Freeze the entry** (decision record): id, enablement source, probe or
   passive signal, failure semantics. Prefer an existing health endpoint the
   service already exposes — never duplicate probe logic.
2. **Registry**: add the id to `CapabilityId` (`project/shared/src/health.ts`)
   and a private assembler in `CapabilitiesService`; wire it into
   `assembleCapabilities`. Enabled-but-broken must map to `unreachable` with
   an error naming the consequence.
3. **Config**: new env vars go through `config.ts` AND `docker-compose.yml` /
   `.env.example` (the `env_consistency` spec enforces this) and the deploy
   compose if the capability ships there.
4. **Panel copy**: `capabilities-model.ts` — name, one-line description, the
   loud consequence in user terms, and the `cogeto features enable <id>` hint.
   No em/en dashes (the lint dash guard).
5. **Operator script**: a `features_enable`/`features_disable` case editing
   `.env` idempotently; typed confirmation if disabling loses a protection;
   `require_feature_service` if it rides a compose service. Update
   `FEATURE_IDS` and the usage text.
6. **Tests**: extend `registry_states`, `panel_renders_states` fixtures, and
   the script spec; the banner picks the new entry up automatically (it
   renders the whole snapshot).
7. **Docs**: the runbook's features section and this file.
