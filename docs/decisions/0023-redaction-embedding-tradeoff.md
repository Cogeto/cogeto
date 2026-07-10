# 0023 — Redaction covers embeddings; local embeddings deferred to v1.x (O3-B)

**Status:** Accepted. **Context:** redaction mode (Addendum B.8) pseudonymizes
entity text before any external model call and re-identifies the response. The
open question the O3-B prompt names explicitly: **what to do about embeddings.**
Pseudonymized text embeds worse (the vector loses the entity's semantics), so
there is a real trade-off. The framing that "the vector store is local, so exempt
embeddings" does **not** hold here: Qdrant is inside the instance, but the
**embedding call itself goes to Mistral** — real entity text in that request would
leave the box and defeat the entire redaction guarantee.

## Decision

**Redact embeddings too.** When redaction is on, `embed()` pseudonymizes every
input before it reaches Mistral, exactly like completion/extraction. There is
nothing to re-identify (the result is a vector). This is the only honest v1
option: the alternative — exempting embeddings — would silently ship real names,
amounts, IBANs, and OIBs to an external API while advertising "PII never leaves
your box."

**Local embeddings are the v1.x path that removes the trade-off.** A CPU/local
embedding model stays inside the trust boundary, so it needs no redaction and
recovers full semantic quality. It is a dependency (model, memory, eval
re-baseline) and is therefore **deferred to v1.x**, not bolted on here.

## The cost, stated plainly

Pseudonymization degrades embedding-based retrieval two ways:

1. **Semantic loss** — `[person1] promised [person2] the proposal` carries less
   meaning than the named sentence, so nearest-neighbour ranking is weaker.
2. **Cross-document inconsistency** — pseudonyms are numbered **per call**
   (decision-0022-style within-call consistency), so "Ana Kovač" may be
   `[person1]` in one note and `[person2]` in another. A query's pseudonyms need
   not match a stored fact's, which blunts entity-anchored retrieval specifically.

Extraction and answering are affected far less: within a single call the model
sees consistent pseudonyms, extracts the correct *structure*, and the gateway
re-identifies the result — so `contradicts`/`supersedes`/task derivation keep
working on real entities. The measurable hit concentrates in embedding recall.

Mitigations already in place: hybrid retrieval (§A.5) also uses full-text and
entity-array signals on the **real** stored text (Postgres holds the truth,
un-redacted for the owner inside the instance), so entity search does not rely on
the vector alone. This softens the embedding cost materially.

## Eval delta

The harness measures it: `npm run eval` builds the gateway through
`createModelGateway`, which reads `REDACTION_ENABLED`/`REDACTION_URL`, so the same
command measures both arms:

```bash
npm run eval                                             # redaction OFF (baseline)
REDACTION_ENABLED=1 REDACTION_URL=http://localhost:8080 npm run eval   # redaction ON
```

(Requires the sidecar running and a Mistral key.) Both runs are recorded in
`docs/eval/history.md`. **Measured delta: pending an owner run** — this session
could not execute it in-band (it needs the built Presidio image + a live Mistral
budget; same constraint flagged for the O3-A live compose). The expected shape,
from the analysis above: extraction precision/recall and verification agreement
move little; the golden set's embedding-dependent surfaces (dedup similarity,
retrieval coverage in `eval:chat`) show the largest drop. If the measured delta is
material, the O3-B session log says so plainly and it is the argument for pulling
local embeddings forward from v1.x.

## Residual limitation (must be stated to users)

Redaction covers the **configured entity categories only** (person, organization,
location, email, phone, IBAN, credit card, monetary amount, Croatian OIB, plus
any custom recognizers). It **cannot guarantee that no sensitive information
leaves in free text** — an unusual name the NER misses, or a sensitive fact
phrased without a named entity, can still pass through. It is a strong, honest
reduction of exposure, not a proof of zero leakage. This sentence appears in the
sidecar README and the compose/README operator docs.

## Consequences

- `embed()` is wrapped by the redaction decorator; `reindex` re-embeds
  pseudonymized text under redaction (matching how vectors were first made) — a
  reindex with redaction toggled between builds would produce an inconsistent
  index, so the toggle is an instance-lifetime setting, not a per-run flag.
- The residual-limitation statement is load-bearing for the compliance one-pager
  (§B.10): redaction is described as category-scoped, never as "no PII leaves."
