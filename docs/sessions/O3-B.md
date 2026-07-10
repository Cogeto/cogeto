# Session O3-B — The redaction sidecar (Addendum B.8)

**Model:** Opus 4.8. **Implements:** redaction mode — local CPU NER that
pseudonymizes sensitive entities before any external model call and re-identifies
the response (*"PII never leaves your box, even though a frontier model answers
you"*). **Decisions:** `0023` (the embedding trade-off), under the `0002` language
boundary (Python only where a model runs, isolated behind the gateway seam). **No
migration.**

## Architectural boundary (held)

The sidecar is a **stateless internal HTTP service**. The **only** caller is the
model gateway — `RedactionClient` is *not* exported from the module index, so no
other module can reach it (dependency-cruiser green). It **never touches the
database** and **stores nothing**: `/pseudonymize` returns the mapping to the
gateway, which holds it in memory for the one call and re-identifies locally.

## 1. The service (`project/services/redaction/`)

Python/FastAPI, its own Dockerfile, **no dependency on the TypeScript workspace**.
Stateless design (chosen and justified): `/pseudonymize {text, session_id?} →
{text, mapping, entities}`, `/reidentify {text, mapping} → {text}`, `/health`. The
sidecar keeps nothing; the mapping round-trips through the caller. Detection is
**Presidio** (`presidio-analyzer`/`-anonymizer`) with built-ins for person, org,
location, email, phone, IBAN, credit card, plus **custom recognizers** for
monetary amounts and the **Croatian OIB** — and a documented extension point for
more Croatian patterns (OIB checksum, name deny-lists, an `hr` spaCy model).
Pseudonyms are **consistent within a call** (the same `Ana Kovač` is `[person1]`
everywhere) and **reversible**. CPU-only, ~0.7–1 GB RSS (spaCy `en_core_web_lg`),
healthcheck loads the model so an un-loadable container reports unhealthy.

Pseudonymize/re-identify is pure string logic (`app/redactor.py`), split from
Presidio so `redaction_roundtrip` and `redaction_consistent` run without the
model. Verified green in-session (4 pure-logic assertions).

## 2. Gateway integration

A `RedactingModelGateway` **decorator** (not a change to the Mistral gateway)
wraps `complete` / `completeStream` / `extractStructured` / `embed`: it
pseudonymizes the `input` before the call and re-identifies the response before it
reaches any caller (structured results are re-identified deep; streams are
re-identified on word boundaries so a pseudonym is never split). The versioned,
PII-free `system` prompt passes through untouched. Every construction site — the
DI module **and** all bare entrypoints (eval, dream, reindex, reminders, smokes)
— now builds the gateway through one `createModelGateway` factory, so **nothing
bypasses redaction**.

**Embeddings are redacted too (decision 0023).** The embed call goes to Mistral,
so exempting it would leak entities and defeat the guarantee; the honest v1 choice
is to pseudonymize embed inputs and accept a retrieval-quality cost, with **local
embeddings as the v1.x fix**. Cost analysed in 0023; eval delta harness wired
(`REDACTION_ENABLED`/`REDACTION_URL`), measurement pending an owner run (see
below).

**Fail closed.** Pseudonymization runs first; if the sidecar is unreachable or
errors, `RedactionClient` throws a `ModelGatewayError` and the model call **never
happens** — never a plaintext fallback. This is the whole point, and it is a test.

## 3. Compose and operations

`docker-compose.yml`: the `redaction-placeholder` is replaced by the real
`redaction` service (own build context `project/services/redaction`, healthcheck,
**internal network only — no published ports**). The app/worker gateway reads
`REDACTION_ENABLED`/`REDACTION_URL` (both in the shared env, off by default).
Enable:

```bash
REDACTION_ENABLED=1 docker compose --profile redaction up --build
```

`.env.example` documents the three vars (env-consistency test stays green —
they're a separate `REDACTION_*` namespace, deliberately not `COGETO_*`). The
sidecar README states what the tier does, **what it does not guarantee**, the
memory cost, and how to enable it.

## 4. Tests, gates

- **Python** (`project/services/redaction/tests/`): `test_redactor.py` —
  `redaction_roundtrip`, `redaction_consistent` (+ [person1]/[person10] safety,
  overlap resolution), pure, ran green here. `test_presidio.py` — real detection
  through the endpoints, `pytest.importorskip` so it skips without the model
  (owner runs it in/against the image).
- **TypeScript** (`model-gateway/redaction.spec.ts`, 10 tests, green):
  `redaction_in_path` (outbound payload carries no real entity string; response
  re-identified; embeddings redacted; streaming re-identified), `redaction_fail_closed`
  (dead sidecar **and** a 5xx → failed call, upstream never invoked),
  `redaction_off_noop` (factory returns the bare gateway when off — not wrapped),
  plus pure re-identify/stream tests.

Full server suite (193 passed), lint, dependency-boundaries, build: green. Both
compose profiles (`demo`, `redaction`) validate.

**Live sidecar validation (done in-session).** The image builds (pins valid) and
was run for real: `/health` loads the model, and `/pseudonymize` on a full-PII
sentence correctly redacts **person, organization, location, email, phone, IBAN,
monetary amount, and OIB**, consistently and reversibly (`/reidentify` round-trips
exactly). This surfaced a real bug that would otherwise have shipped: Presidio's
default `labels_to_ignore` **drops `ORG`/`ORGANIZATION`**, so organizations were
silently un-redacted until the NLP-engine entity mapping + `labels_to_ignore`
were overridden in `main.py`. (The Python NER on Croatian text over-redacts common
words — the safe direction — which is why an `hr` model / name lists are the
documented extension point.)

**A second defect surfaced by a live capture through the pipeline** (owner test):
the original ALL-CAPS pseudonyms (`PERSON_1`) collided with the pipeline's own
ALL-CAPS prompt labels (`SURROUNDING SOURCE TEXT`, `REFERENCE TIME`), and the
small pipeline model conflated them — spilling prompt scaffolding into the
extracted fact. Fix: pseudonyms are now **bracketed, lowercase slots**
(`[person1]`, `[company1]`) — they can't be mistaken for prompt structure, and
the brackets self-delimit so re-identification is an exact swap that never touches
a user's own text (`person1` written by the user is left alone). Verified against
the rebuilt image; reversal is exact.

**A third, deeper leak (owner test, separate from redaction):** the extraction
input prepends ALL-CAPS metadata labels (`REFERENCE TIME`, `SOURCE TYPE`,
`SOURCE CONTENT`, `buildExtractionInput`), and the small model sometimes grabbed
`REFERENCE TIME` as a fact's subject — worst under redaction, where the real
names are bracketed slots so the ALL-CAPS labels are the only capitalized tokens
left. The extraction prompt already says "FYI only … extract only from SOURCE
CONTENT", but a weak model doesn't always comply. Fix: a **provenance guard** in
`ExtractStage` (`carriesMetadataLabel`) drops any candidate fact whose claim,
span, or subject carries one of those labels — such a "fact" is never grounded in
the content. Targeted (no legitimate note fact contains them), so it can't drop
real facts; unit-tested (`extract-guard.spec.ts`). Redaction-agnostic — a general
robustness improvement the redaction visibility surfaced.

## The demo (capture with names → inspect logs)

With `REDACTION_ENABLED=1 docker compose --profile redaction up --build`:

1. Capture a note full of PII — e.g. *"Ana Kovač at Adriatic Foods confirmed the
   €48,000 fee; invoice to billing@adriaticfoods.hr, OIB 12345678901."*
2. Watch the worker process it. The extraction/embedding calls to Mistral carry
   only `[person1]`, `[company1]`, `[amount1]`, `[email1]`, `[oib1]` — never the real
   strings. (pino never logs memory content or tokens, so confirm at the sidecar:
   `docker compose --profile redaction logs redaction` shows request counts, and a
   direct `curl` to `/pseudonymize` demonstrates the mapping.)
3. The stored memory reads back with real names (re-identified in-box); ask about
   it in chat and the answer names Ana — the frontier model never saw her.

## Eval delta

**Pending an owner run** — not executable in-session (needs the built Presidio
image + a live Mistral budget). The harness measures both arms with one command
(redaction off vs on); `docs/eval/history.md` has the row to fill. Expected shape
(decision 0023): extraction/verification barely move; embedding-dependent surfaces
(dedup, `eval:chat` coverage) take the largest hit because per-call pseudonym
numbering isn't consistent across documents. If material, that is the case for
pulling local embeddings forward from v1.x. Said plainly here rather than hidden.

## Owner checklist

- [ ] **Build + run the profile:** `REDACTION_ENABLED=1 docker compose --profile
      redaction up --build`. First build downloads `en_core_web_lg` (~600 MB) and
      the healthcheck goes green once the model loads (~60–90 s). Confirm memory
      sits in the ~0.7–1 GB band; drop to `REDACTION_SPACY_MODEL=en_core_web_md`
      if tighter.
- [ ] **Verify the pin.** `presidio-analyzer==2.2.355` / `spacy==3.7.5` are
      pinned; if the image build fails, bump to the current compatible pair (the
      code is version-agnostic — it uses the stable Presidio API).
- [ ] **Run the Python detection tests** in/against the image:
      `pytest project/services/redaction/tests -q` (needs deps + model).
- [ ] **Measure the eval delta** (both commands in `docs/eval/history.md`) and
      fill the table; if the drop is material, weigh pulling local embeddings
      forward.
- [ ] **Fail-closed drill:** with redaction on, stop the sidecar and confirm a
      capture's model call fails (dead-letters) rather than proceeding — never a
      plaintext call.
- [ ] Redaction is an **instance-lifetime** setting: don't toggle it between
      reindexes (the index would mix redacted and un-redacted vectors).

## What O3-B deliberately did NOT do

- **Local embeddings** (the v1.x fix for the embedding trade-off — decision 0023).
- A UI toggle — redaction is a deploy-time profile (per-tenant), not an in-app
  setting, in v1.
- The measured eval numbers (owner-run; harness + honest expectation shipped).
