# Capabilities: observable, controllable, announced

Optional services used to be compose profiles with invisible state: the operator often
could not tell what was enabled, what was running, or what was silently broken.
Nothing in the product, the operator script, or the boot log stated the truth in one
place. Now one registry does.

## One authoritative registry

Every optional capability is an entry in a single registry, a composition-root concern
that reads other modules only through their public interfaces. An entry states how
enablement is determined, how health is checked, and its failure semantics.

| id | Enablement | Health probe | Failure semantics |
| --- | --- | --- | --- |
| `redaction` | the same flag the gateway obeys | sidecar health endpoint | **fail-closed**: unreachable means model calls fail, never plaintext |
| `research` | the `research` profile, or an explicit flag | SearXNG health endpoint | **degrade with message**: the feature answers "search unavailable" |
| `demo` | the demo-mode flag | passive: the production-guard state | demo plus production makes the guard refuse the seed, loudly |
| `consoles` | the `consoles` profile, or an explicit flag | none | the console edge binds to host loopback; the app has nothing it can probe, and says so |
| `local-models` | any tier resolved to the local provider | runtime reachability plus required models pulled | **external dependency**: boot refuses, and a runtime that dies later goes loud here |

Scheduled jobs join the same surface as a second category: `dreaming` and `sweep`, each
with last-run time, last result, and an overdue state.

## States and loudness

Capabilities are `on`, `unreachable` (**loud**), or `off`. Jobs are `ok`, `overdue`
(**loud**), or `failing`.

**Loud** means all three of: visually prominent in the panel, a named degradation in
the health endpoint that flips overall status to `degraded`, and a warning log **on the
transition**, not on every poll.

Nothing is inferred silently where it can be checked. Enabled capabilities with a probe
are probed on every uncached read; pure-configuration entries are reported as such,
never guessed at.

## Thresholds

- **Overdue**: no successful run within 26 hours, one nightly slot plus slack. A job
  that never ran stays quiet until the instance itself is older than the threshold.
- **Cache**: registry snapshots are cached 20 seconds in-process. Probes are cheap but
  not free and the panel polls every 10 seconds, so 20 seconds keeps "kill the
  container, watch it go loud" under half a minute.

## Profiles are passed in; explicit flags stay authoritative

A container cannot see which compose profiles are active, so the active list is
mirrored into the environment in both compose files. One line in `.env` is what the
operator script maintains, compose activates those profiles on a plain `up`, and the
app reads the same value.

Where a capability already has an explicit flag, **that flag remains the authority**,
because it is what the behaviour actually follows. Command-line `--profile` flags are
invisible to the container; dev one-offs set the explicit flags instead.

## Control stays in the operator script

`cogeto features [enable|disable <id>]` edits `.env` idempotently, applies, waits for
health, and prints operator to-dos. Disabling redaction and toggling local models (an
embeddings change, so a reindex) require typed confirmations, and enabling demo on a
production instance is refused loudly.

**The web application never gains docker-level privilege.** The panel shows the enable
command; it is not a toggle.

## The boot banner

Every app boot logs one delimited line from the same registry snapshot:

```
Capabilities: redaction ON (healthy) | research OFF | ...  Jobs: dreaming last ran 6h ago | sweep last ran 6h ago.
```

Exact truth, every boot. A failed banner read is itself stated at warn level, never
swallowed.

## Adding one

One registry entry (enablement, probe, semantics, panel copy) and, if operator
togglable, one case in the `features` command.
