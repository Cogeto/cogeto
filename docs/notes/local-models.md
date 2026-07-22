# Local models via Ollama (Post-v1 Priority 4)

Working notes for decision 0041 (issues #181/#182/#183). The instance can run
task tiers on a self-hosted Ollama runtime over the operator's private
network, with local embeddings, gated by eval parity per task and language.
The provider machinery is decision 0040's: `ollama` is a provider flavor over
the OpenAI-compatible adapter, and everything below rides the existing
configuration, reindex, and trust-score plumbing.

## Standing up Ollama for Cogeto

1. **On the runtime host** (a machine with enough RAM/GPU for the chosen
   model): install Ollama, then pull the two models:

   ```sh
   ollama pull gemma3:12b   # generation (pipeline + answer) — the preset default
   ollama pull bge-m3       # embeddings — multilingual (covers Croatian), 1024 dims
   ```

2. **Networking.** `COGETO_OLLAMA_BASE_URL` names the runtime **root** (no
   `/v1`; a pasted `/v1` is tolerated and stripped). Localhost, LAN, and
   WireGuard addresses are all valid — the only requirement is that the
   **containers** can reach it. The compose stack uses the default bridge
   network, so:
   - same host: use an address the bridge can reach (the host's LAN IP, or
     `host.docker.internal` where available) — plain `localhost` inside a
     container is the container itself;
   - LAN: the LAN IP just works;
   - WireGuard (e.g. `http://10.0.0.1:11434`): the Docker **host** holds the
     wg route, and traffic from the bridge subnet must be forwarded/masqueraded
     onto the wg interface (or use host networking for the app/worker — not
     the default). Verify from inside a container before blaming code:
     `docker compose exec app node -e "fetch('http://10.0.0.1:11434/api/tags').then(r=>r.text()).then(console.log)"`.

3. **Boot behavior** (decision 0041 ruling 2): when any tier is bound to
   `ollama`, the app, worker, and reindex probe `<root>/api/tags` at startup.
   An unreachable runtime or a never-pulled model **refuses boot** with the
   exact fix (`ollama pull <model>`). The health surface (`GET /api/health`,
   `gateway` check) reports the runtime's reachability. No API key is needed;
   `COGETO_OLLAMA_API_KEY` exists only for a runtime behind an authenticating
   reverse proxy.

## Presets and switching

```sh
# All-local — pipeline + answer on gemma3:12b, embeddings on bge-m3:
COGETO_PROVIDER_PRESET=ollama-local
COGETO_OLLAMA_BASE_URL=http://10.0.0.1:11434

# Mixed (the RECOMMENDED local posture — see the parity table):
# hosted generation + local embeddings:
COGETO_MISTRAL_API_KEY=…
COGETO_PROVIDER_EMBEDDINGS=ollama
COGETO_MODEL_EMBEDDINGS=bge-m3
COGETO_OLLAMA_BASE_URL=http://10.0.0.1:11434

# Local pipeline + hosted answer:
COGETO_PROVIDER_PIPELINE=ollama
COGETO_MODEL_PIPELINE=gemma3:12b
COGETO_OLLAMA_BASE_URL=http://10.0.0.1:11434
COGETO_MISTRAL_API_KEY=…

# Per-tier timeouts (local inference is seconds-to-minutes; defaults shown):
#COGETO_OLLAMA_TIMEOUT_PIPELINE_MS=300000
#COGETO_OLLAMA_TIMEOUT_ANSWER_MS=300000
#COGETO_OLLAMA_TIMEOUT_EMBEDDINGS_MS=120000
```

Configuration ids derive exactly as in decision 0040 ruling 3: `ollama-local`
on the preset match, else the per-tier form (embeddings-only local is
`pipe-mistral-mistral-small-latest--ans-mistral-mistral-medium-latest--emb-ollama-bge-m3`).
Settings shows the active id read-only; the boot log states it.

**Moving embeddings local requires a reindex** (decisions 0040/0041): changing
the embeddings provider or model marks the vector index stale and the instance
refuses to boot until

```sh
docker compose exec worker npm run reindex
```

has re-embedded everything from Postgres. The reindex recreates the Qdrant
collection at the new model's dimension when it changed, prints `progress
done/total` per batch, and is resumable — a re-run reuses rows already
re-embedded and finishes the rest. The boot guard also checks the live
collection's **dimension** against the active model explicitly, so a
half-migrated index refuses to serve rather than searching a stale space.

## Eval parity: measured, per task and per language

Method: both suites (`npm run eval`, `npm run eval:chat`) run on this branch
against three configurations — the `mistral-default` baseline, embeddings-only
local, and all-local (`ollama-local`: gemma3:12b + bge-m3 on a WireGuard-
reachable GPU host). The chat coverage grader follows each configuration's own
answer tier (the decision 0040 default, stated here for comparability). The
emitted partials carry the exact configuration ids above and fold into a
release's trust-scores file through the owner-run flow below.

Run 2026-07-22 on this branch (issues #181–#183), harness
`extraction/v0002 + verification/v0004 · reconcile_dedup/v0001 +
reconcile_contradiction/v0001 · thresholds v1 + chat answer/v0004 · grader
eval-coverage/v0001`; corpus 68 golden cases (33 en / 35 hr), 20 reconcile
pairs, 14 chat cases. Runtime: gemma3:12b (Q4_K_M) + bge-m3 (F16) on the
owner's GPU host over WireGuard; the full all-local run took ~19 minutes
wall-clock.

Configuration ids: **baseline** `mistral-default`; **embeddings-only local**
`pipe-mistral-mistral-small-latest--ans-mistral-mistral-medium-latest--emb-ollama-bge-m3`;
**all-local** `ollama-local`.

| Task (metric) | Lang | baseline | emb-only local | all-local | all-local parity? |
| --- | --- | --- | --- | --- | --- |
| Extraction precision | en | 0.898 | 0.902 | 0.804 | **no** (−0.094) |
| Extraction precision | hr | 0.769 | 0.764 | 0.694 | **no** (−0.075) |
| Extraction recall | en | 0.911 | 0.956 | 0.911 | yes (=) |
| Extraction recall | hr | 0.867 | 0.889 | 0.756 | **no** (−0.111) |
| Verification agreement | en | 0.906 | 0.938 | 0.938 | yes (+0.031) |
| Verification agreement | hr | 0.824 | 0.794 | 0.882 | yes (+0.059) |
| Dedup accuracy | en | 1.000 | 1.000 | 1.000 | yes (=) |
| Dedup accuracy | hr | 0.833 | 0.833 | 0.833 | yes (=) |
| Contradiction recall | en | 1.000 | 1.000 | 0.667 | **no** (−0.333) |
| Contradiction recall | hr | 1.000 | 1.000 | 0.667 | **no** (−0.333) |
| Task closure accuracy | en | 1.000 | 1.000 | 1.000 | yes (=) |
| Task closure accuracy | hr | 1.000 | 1.000 | 1.000 | yes (=) |
| Task condition accuracy | en | 1.000 | 1.000 | 1.000 | yes (=) |
| Task condition accuracy | hr | 1.000 | 1.000 | 1.000 | yes (=) |
| Chat suite (passed/cases) | mixed | 14/14 | 14/14 | 12/14 | **no** (failed: `create_task_hr_uvjet`, `who_is_ana`) |

**Verdict per task family:**

- **Embeddings / retrieval (bge-m3): parity holds in both languages.** The
  embeddings-only-local configuration matches or beats the baseline on every
  metric and passes the full chat suite (whose retrieval-dependent cases
  exercise the vector path end to end). Local embeddings are ready as a
  default local posture.
- **Verification: parity holds** in both languages under all-local (gemma3:12b
  actually agrees with the golden labels more often than the baseline).
- **Dedup: parity holds** in both languages under all-local.
- **Task closure and condition: parity holds** in both languages under
  all-local (12/12 pairs on every configuration).
- **Extraction: parity does NOT hold under all-local.** Precision drops in
  both languages (en −0.094, hr −0.075) and recall drops in hr (−0.111).
  Croatian is the weaker language for the local generation model.
- **Contradiction confirmation: parity does NOT hold under all-local** (0.667
  vs 1.000 in both languages). Stated plainly: this aggregate (0.667) is
  below the CI gate ratchet for `mistral-default` (0.7) — an all-local
  instance would not pass today's gates on this task.
- **Chat: 12/14 under all-local.** `create_task_hr_uvjet` (Croatian
  conditional task creation) and `who_is_ana` failed; note the all-local
  coverage grader is gemma3:12b itself (each configuration grades with its own
  answer tier — the 0040 default, held here).

**Bottom line:** the **mixed preset — hosted generation + local bge-m3
embeddings — is the recommended local posture**; it holds parity everywhere
and moves the highest-volume data flow (every embedded memory) onto the
operator's own hardware. The `ollama-local` preset works end to end and stays
available for operators who require zero external calls and accept the
measured gaps above, knowingly.

## Migration gating (the standing rule)

A task family migrates to local **by default preset** only where the local
configuration holds parity **per language** on that task. Where it does not,
this note says so plainly, and the **mixed preset (hosted generation + local
embeddings) remains the recommended local posture**. Nothing silently
degrades: the `ollama-local` preset stays available where it misses parity —
the operator may accept the measured tradeoff knowingly — but the gap is
stated above, not hidden. CI keeps gating on `mistral-default` only; local
runs are owner-run (the runtime lives on the owner's network) and are
recorded, never CI gates.

## Owner flow: local evals into a release's trust scores

Same flow as any alternate configuration (decision 0040 ruling 5 /
`model-providers.md`), run on a machine that reaches the runtime:

```sh
# Embeddings-only local:
COGETO_PROVIDER_EMBEDDINGS=ollama COGETO_MODEL_EMBEDDINGS=bge-m3 \
COGETO_OLLAMA_BASE_URL=http://10.0.0.1:11434 \
  npm run eval -- --emit-json /tmp/ollama-mixed.json
COGETO_PROVIDER_EMBEDDINGS=ollama COGETO_MODEL_EMBEDDINGS=bge-m3 \
COGETO_OLLAMA_BASE_URL=http://10.0.0.1:11434 \
  npm run eval:chat -- --emit-json /tmp/ollama-mixed.json

# All-local:
COGETO_PROVIDER_PRESET=ollama-local COGETO_OLLAMA_BASE_URL=http://10.0.0.1:11434 \
  npm run eval -- --emit-json /tmp/ollama-local.json
COGETO_PROVIDER_PRESET=ollama-local COGETO_OLLAMA_BASE_URL=http://10.0.0.1:11434 \
  npm run eval:chat -- --emit-json /tmp/ollama-local.json

# At release time, each file is an extra --partial (own entry on the trust page):
node scripts/ci/publish-trust-scores.mjs --version vX.Y.Z --sha <commit> \
  --partial trust-default.json --partial /tmp/ollama-mixed.json \
  --partial /tmp/ollama-local.json \
  --note "local configurations run by the owner on <date> against gemma3:12b + bge-m3; graders follow each configuration's answer tier (0041 r6)"
```

The harness prints `configuration: <id>` at start — verify it before letting a
run cost hours. Different configurations go to different files; the merge
refuses mismatched ids.

## Gotchas

- The first call after the runtime sits idle pays model-load latency (tens of
  seconds for a 12B on CPU); the boot probe does not preload. The generous
  default timeouts absorb this — do not tighten them below real load times.
- A timed-out local call is **fatal, not retried** (retrying a saturated
  runtime piles on); the error names the exact `COGETO_OLLAMA_TIMEOUT_*_MS`
  variable. Connection-refused stays retryable (the runtime may be restarting).
- Ollama tag names: `bge-m3` and `bge-m3:latest` are the same model; the boot
  probe and the dimensions table both tolerate the `:tag` suffix. A **tagged**
  configuration name must match exactly (`gemma3:12b` is not `gemma3:latest`).
- Budgets and redaction apply to local calls exactly as to hosted ones —
  tokens are counted even at zero cost; the accounting stays uniform.
