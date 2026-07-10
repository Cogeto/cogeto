# Redaction sidecar (`--profile redaction`, Addendum B.8)

A stateless, CPU-only Python service that detects and **pseudonymizes** sensitive
entities so PII never leaves the instance in an external model call — *"PII never
leaves your box, even though a frontier model answers you."* Governing decisions:
[`0002`](../../../docs/decisions/0002-technology-stack.md) (Python only where a
model runs, isolated behind the gateway seam) and
[`0023`](../../../docs/decisions/0023-redaction-embedding-tradeoff.md) (the
embedding trade-off).

## Architectural boundary (non-negotiable)

- **The only caller is the model gateway.** No other module may reach it (the
  `RedactionClient` is private to `project/src/model-gateway/`).
- **Stateless**: it never touches a database and stores nothing. `/pseudonymize`
  returns the mapping to the gateway, which holds it in memory for the one call
  and passes it back to `/reidentify`.
- **CPU-only, ~1 GB RAM** (spaCy `en_core_web_lg`), no GPU, no local LLM.

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/health` | — | `{status, model}` (loads the model → unhealthy if it can't) |
| `POST` | `/pseudonymize` | `{text, session_id?}` | `{text, mapping, entities}` |
| `POST` | `/reidentify` | `{text, mapping}` | `{text}` |

Pseudonyms are consistent within a call (the same `Ana Kovač` is `[person1]`
everywhere) and reversible via the mapping — see `app/redactor.py`.

## Detected entities

Built-in (Presidio): `PERSON`, `ORGANIZATION`, `LOCATION`, `EMAIL_ADDRESS`,
`PHONE_NUMBER`, `IBAN_CODE`, `CREDIT_CARD`. Custom (`app/recognizers.py`):
`MONETARY_AMOUNT`, `CROATIAN_OIB`.

### Adding Croatian-specific patterns

The recognizer set is the extension point (`app/recognizers.py`):

- **OIB with checksum** — replace the current 11-digit regex with a
  checksum-validating `PatternRecognizer` (raises precision).
- **Croatian name lists** — `PatternRecognizer(supported_entity="PERSON",
  deny_list=[...])` loaded from a names file, or swap `SPACY_MODEL` to a Croatian
  pipeline. Add the entity to `SUPPORTED_ENTITIES` and (if new) a prefix in
  `redactor.ENTITY_PREFIX`. Nothing else changes.

## What it does NOT guarantee

Redaction covers the **configured entity categories only**. It cannot guarantee
that *no* sensitive information leaves in free text — an unusual name the NER
misses, or a sensitive fact phrased without a named entity, can still pass
through. It is a strong, honest reduction of exposure, not a proof of zero
leakage. Embeddings are pseudonymized too (decision 0023), which degrades
retrieval quality; local embeddings are the v1.x path that removes the trade-off.

## Enable it

```bash
docker compose --profile redaction up --build
```

The profile sets `REDACTION_ENABLED=1` and `REDACTION_URL` on the app + worker;
the gateway then pseudonymizes every outbound model call and re-identifies the
response. If the sidecar is unreachable, model calls **fail closed** (never sent
in plaintext). Memory cost: ~0.7–1 GB RSS for this container (spaCy model).

## Tests

```bash
# pure pseudonymization logic (no model needed)
python3 -m pytest project/services/redaction/tests/test_redactor.py -q

# real Presidio detection (needs the deps + model; run in/against the image)
python3 -m pytest project/services/redaction/tests/test_presidio.py -q
```
