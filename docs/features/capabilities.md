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
| `mail` | the `mail` profile, or an explicit flag | TCP connect to the inbound SMTP listener | **loud when enabled and dead**: forwarded mail is not being received. Off is the default, and a mail-less instance is not degraded |
| `demo` | the demo-mode flag | passive: the production-guard state | demo plus production makes the guard refuse the seed, loudly |
| `consoles` | the `consoles` profile, or an explicit flag | none | the console edge binds to host loopback; the app has nothing it can probe, and says so |
| `local-models` | any tier resolved to the local provider | runtime reachability plus required models pulled | **external dependency**: boot refuses, and a runtime that dies later goes loud here |
| `vision` | Reading pages that are pictures (V2.1 item 4.1). PROBED by sending a real image: the same weights are served with and without a multimodal projector, so nothing short of an image can answer the question. `off` means the reading ladder stops at local OCR, which is a supported state; `unreachable` names which of the failures happened. |
| `reasoning` | The generation model returns its thinking in a separate reasoning field (Part B of reasoning support). PROBED by sending a real prompt, for the same reason vision is probed: the identical weights are served both ways, and only a response says which way this instance got them. `on` arms a maxTokens headroom multiplier (COGETO_REASONING_HEADROOM, default 4) on the bindings that reasoned, so thinking cannot silently consume an answer's token budget; `off` is a complete, healthy answer and changes nothing. Never `unreachable`: a dead endpoint is the gateway health check's finding. |

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

## Reasoning: a probed fact with a behavioural consequence

The `reasoning` entry differs from the others in two deliberate ways.

First, its probe has a side effect. A reasoning model leaves `content` empty
until its thinking finishes, so any maxTokens cap can be entirely consumed by
reasoning and come back as an empty string that looks like a model failure.
The probe's completion teaches the provider adapter which bindings reason, and
the adapter then multiplies every maxTokens on those bindings by the headroom
factor. That is why the registry runs the reasoning probe BEFORE the vision
probe: the vision probe's small cap only survives a reasoning vision binding
once the headroom is armed. When the budget is still exhausted by reasoning,
the failure is named (`reasoning_exhausted`, "the model spent its entire
output budget on reasoning") instead of masquerading as a network or projector
fault. The worker runs the same probe at boot as a warmup, so the first
document read after a restart is not the discovery mechanism.

Second, its probe costs a model completion on every configured instance, not
only on instances that opted into a binding, so it keeps its own longer cache
(ten minutes) inside the registry instead of re-running per 20-second
snapshot. The adapter keeps learning from every real response in between, so
a runtime restarted the other way is caught by the first response either way.

The probe reads the reasoning field only as a yes/no. The thinking text is
discarded in the adapter: it is never stored, verified, cited, displayed or
evaluated, and it can never reach the JSON parser behind structured
extraction. Displaying it as a channel is Parts A and C of the reasoning
design, deliberately not this. The configuration fingerprint does not yet
carry a reasoning marker for the same reason: whether a binding reasons is a
probed runtime fact, and the fingerprint is derived before any probe can run;
the marker lands with the channel in Part C.

## Thresholds

- **Overdue**: no successful run within 26 hours, one nightly slot plus slack. A job
  that never ran stays quiet until the instance itself is older than the threshold.
- **Cache**: registry snapshots are cached 20 seconds in-process, and since issue
  #418 a STALE snapshot is served instantly while one background pass (single
  flight) rebuilds it: the vision probe on a reasoning binding is a 10-to-15-second
  model call, and a panel poll must never sit behind it. Every entry carries the
  `checkedAt` of the pass that measured it, and a dead capability still goes loud
  on the next background pass rather than on somebody's page load. The very first
  read (the boot banner's) builds synchronously; the banner states measured truth.
- **Model-call probes cache longer.** Two probes cost a model call and keep their
  own windows inside the registry: reasoning ten minutes (a completion on every
  configured instance) and vision three minutes (an image through a possibly
  thinking model). "Kill the runtime, watch it go loud" is minutes for those two
  and still under half a minute for everything else; the reading ladder's own
  per-document vision probe (60 seconds) is separate and unchanged, so document
  reads discover a dead runtime at the old speed.

## Profiles are passed in; explicit flags stay authoritative

A container cannot see which compose profiles are active, so the active list is
mirrored into the environment in both compose files. One line in `.env` is what the
operator script maintains, compose activates those profiles on a plain `up`, and the
app reads the same value.

Where a capability already has an explicit flag, **that flag remains the authority**,
because it is what the behaviour actually follows. Command-line `--profile` flags are
invisible to the container; dev one-offs set the explicit flags instead.

## Inbound mail is a capability, not a fixture

Until security audit 2.0 (SEC-14) the mail service had no profile at all: every
instance published an internet-facing SMTP listener on port 25 and parsed hostile
SMTP, whether or not the customer used email capture, with no supported way to turn it
off. It is now an ordinary member of this table: off by default, enabled with
`cogeto features enable mail` (which also opens the firewall port and prints the MX and
PTR steps), disabled with the matching command (which closes the port again).

Two consequences worth stating, because they are what makes "off" honest rather than
cosmetic: with the capability off the health check reports "inbound mail capability is
off" and stays **green** rather than failing against a listener that is deliberately
absent, and the installer's checklist omits the mail DNS records entirely instead of
telling an operator to point real mail at nothing.

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
