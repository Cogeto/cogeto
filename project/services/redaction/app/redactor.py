"""Reversible, consistent pseudonymization (Addendum B.8, decision 0002 language
boundary). Detection is Presidio (Python is where the NER model runs); the
pseudonymization/re-identification below is pure string logic, split out so it is
unit-testable without loading the spaCy model.

Consistency contract: within one call the same entity surface maps to the same
numbered pseudonym everywhere (PERSON_1, ORG_1, AMOUNT_1, …); the returned mapping
reverses it exactly. The service stores nothing — the mapping goes back to the
caller (the model gateway) which holds it in memory for the duration of the call.
"""

from __future__ import annotations

from dataclasses import dataclass

# Presidio entity type → pseudonym prefix. Anything unlisted falls back to the
# entity type itself, so a new recognizer is usable before this table is updated.
#
# Pseudonyms are BRACKETED, LOWERCASE slots — `[person1]`, `[company1]`. Two
# reasons, both learned from a live run:
#  1. ALL-CAPS tokens (`PERSON_1`) collide with the pipeline's own ALL-CAPS prompt
#     labels (SURROUNDING SOURCE TEXT, REFERENCE TIME); a small model conflates
#     them and spills scaffolding into the extracted fact. A bracketed lowercase
#     slot looks like nothing else in the prompt.
#  2. A bare token like `Person1` could legitimately appear in a user's own text,
#     and re-identification would then rewrite it by mistake. `[…]` self-delimits,
#     so reversal is an exact, unambiguous string swap (no word-boundary edge
#     cases) that only ever touches the slots the sidecar itself minted.
ENTITY_PREFIX: dict[str, str] = {
    "PERSON": "person",
    "ORGANIZATION": "company",
    "LOCATION": "place",
    "GPE": "place",
    "NRP": "group",
    "EMAIL_ADDRESS": "email",
    "PHONE_NUMBER": "phone",
    "IBAN_CODE": "iban",
    "CREDIT_CARD": "card",
    "MONETARY_AMOUNT": "amount",
    "CROATIAN_OIB": "oib",
}


@dataclass(frozen=True)
class Span:
    """A detected entity span (half-open [start, end))."""

    start: int
    end: int
    entity_type: str
    score: float = 1.0


def _resolve_overlaps(spans: list[Span]) -> list[Span]:
    """Greedy non-overlapping selection: earliest start wins, ties broken by the
    longer (then higher-scoring) span, so 'Ana Kovač' beats a nested 'Ana'."""
    ordered = sorted(spans, key=lambda s: (s.start, -(s.end - s.start), -s.score))
    kept: list[Span] = []
    last_end = -1
    for span in ordered:
        if span.start >= last_end:
            kept.append(span)
            last_end = span.end
    return kept


def pseudonymize(text: str, spans: list[Span]) -> tuple[str, dict[str, str]]:
    """Replace every detected span with a stable numbered pseudonym.

    Returns (pseudonymized_text, mapping) where mapping[pseudonym] = original
    surface. The same (entity_type, surface) always yields the same pseudonym,
    numbered by first appearance so the output reads naturally.
    """
    kept = _resolve_overlaps(spans)
    assigned: dict[tuple[str, str], str] = {}
    mapping: dict[str, str] = {}
    counters: dict[str, int] = {}

    # First pass, left-to-right: assign pseudonyms by first appearance.
    for span in sorted(kept, key=lambda s: s.start):
        surface = text[span.start : span.end]
        key = (span.entity_type, surface.strip().casefold())
        if key not in assigned:
            prefix = ENTITY_PREFIX.get(span.entity_type, span.entity_type.lower())
            counters[prefix] = counters.get(prefix, 0) + 1
            pseudonym = f"[{prefix}{counters[prefix]}]"
            assigned[key] = pseudonym
            mapping[pseudonym] = surface.strip()

    # Second pass, right-to-left: splice replacements without shifting offsets.
    result = text
    for span in sorted(kept, key=lambda s: s.start, reverse=True):
        surface = text[span.start : span.end]
        key = (span.entity_type, surface.strip().casefold())
        result = result[: span.start] + assigned[key] + result[span.end :]
    return result, mapping


def reidentify(text: str, mapping: dict[str, str]) -> str:
    """Reverse pseudonymization. The slots are bracketed (`[person1]`), so an
    exact string swap is unambiguous — `[person1]` is never a substring of
    `[person10]`. Longest first for defence against any unforeseen overlap."""
    for pseudonym in sorted(mapping, key=len, reverse=True):
        text = text.replace(pseudonym, mapping[pseudonym])
    return text
