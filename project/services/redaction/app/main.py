"""Cogeto redaction sidecar (Addendum B.8; decision 0002 language boundary).

A stateless internal HTTP service — the ONLY caller is the model gateway. It
never touches a database and stores nothing: /pseudonymize returns the mapping to
the caller, which passes it back to /reidentify. CPU-only, ~1 GB RAM (spaCy NER),
no GPU, no local LLM.

Adding Croatian-specific detection: drop a new `PatternRecognizer` (e.g. an
OIB-with-checksum, an MBO, or a deny-list of Croatian given/family names loaded
from a file) into `recognizers.CUSTOM_RECOGNIZERS`, add its entity type to
`SUPPORTED_ENTITIES`, and (if new) a prefix in `redactor.ENTITY_PREFIX`. For name
lists, `PatternRecognizer(deny_list=[...])` or a spaCy `en`/`hr` model swap via
`SPACY_MODEL` is the extension point; nothing else changes.
"""

from __future__ import annotations

import os
from functools import lru_cache

from fastapi import FastAPI
from pydantic import BaseModel, Field

from .recognizers import CUSTOM_RECOGNIZERS, SUPPORTED_ENTITIES
from .redactor import Span, pseudonymize, reidentify

SPACY_MODEL = os.environ.get("SPACY_MODEL", "en_core_web_lg")

app = FastAPI(title="Cogeto redaction sidecar", version="1.0.0")


@lru_cache(maxsize=1)
def _analyzer():
    """Builds the Presidio analyzer once (loads the spaCy model). Imported lazily
    so the pure redactor logic + its tests need neither Presidio nor the model."""
    from presidio_analyzer import AnalyzerEngine, RecognizerRegistry
    from presidio_analyzer.nlp_engine import NlpEngineProvider

    # Presidio keeps ONLY the spaCy entity labels present in this mapping and
    # drops the rest from nlp_artifacts — and its default mapping omits ORG, so
    # organizations never reach a recognizer. Map ORG → ORGANIZATION explicitly
    # (and the usual person/location labels) so the built-in recognizers emit them.
    nlp_engine = NlpEngineProvider(
        nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": SPACY_MODEL}],
            "ner_model_configuration": {
                "model_to_presidio_entity_mapping": {
                    "PERSON": "PERSON",
                    "PER": "PERSON",
                    "ORG": "ORGANIZATION",
                    "FAC": "ORGANIZATION",
                    "GPE": "LOCATION",
                    "LOC": "LOCATION",
                    "NORP": "NRP",
                },
                # Presidio's default ignores ORG/ORGANIZATION — we WANT orgs, so
                # override the list (keep the genuinely noisy labels ignored).
                "labels_to_ignore": [
                    "CARDINAL",
                    "O",
                    "PRODUCT",
                    "EVENT",
                    "PERCENT",
                    "LAW",
                    "QUANTITY",
                    "LANGUAGE",
                    "ORDINAL",
                    "WORK_OF_ART",
                    "MONEY",
                    "DATE",
                    "TIME",
                ],
                "low_confidence_score_multiplier": 0.4,
                "low_score_entity_names": [],
            },
        }
    ).create_engine()

    registry = RecognizerRegistry()
    registry.load_predefined_recognizers(nlp_engine=nlp_engine, languages=["en"])
    for recognizer in CUSTOM_RECOGNIZERS:
        registry.add_recognizer(recognizer)

    return AnalyzerEngine(
        nlp_engine=nlp_engine, registry=registry, supported_languages=["en"]
    )


def detect(text: str) -> list[Span]:
    results = _analyzer().analyze(
        text=text, language="en", entities=SUPPORTED_ENTITIES
    )
    return [Span(r.start, r.end, r.entity_type, float(r.score)) for r in results]


# ── Wire contracts ───────────────────────────────────────────────────────────
class PseudonymizeRequest(BaseModel):
    text: str
    # Accepted and echoed for tracing; the service is stateless and keys nothing
    # on it (the mapping is returned, not stored).
    session_id: str | None = None


class Entity(BaseModel):
    pseudonym: str
    original: str


class PseudonymizeResponse(BaseModel):
    text: str
    mapping: dict[str, str]
    entities: list[Entity]


class ReidentifyRequest(BaseModel):
    text: str
    mapping: dict[str, str] = Field(default_factory=dict)


class ReidentifyResponse(BaseModel):
    text: str


@app.get("/health")
def health() -> dict[str, str]:
    # Touch the analyzer so a container that cannot load the model reports
    # unhealthy (fail-closed at the gateway then keeps model calls from running).
    _analyzer()
    return {"status": "ok", "model": SPACY_MODEL}


@app.post("/pseudonymize", response_model=PseudonymizeResponse)
def pseudonymize_endpoint(req: PseudonymizeRequest) -> PseudonymizeResponse:
    redacted, mapping = pseudonymize(req.text, detect(req.text))
    entities = [Entity(pseudonym=p, original=o) for p, o in mapping.items()]
    return PseudonymizeResponse(text=redacted, mapping=mapping, entities=entities)


@app.post("/reidentify", response_model=ReidentifyResponse)
def reidentify_endpoint(req: ReidentifyRequest) -> ReidentifyResponse:
    return ReidentifyResponse(text=reidentify(req.text, req.mapping))
