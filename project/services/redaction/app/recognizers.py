"""Custom Presidio recognizers layered on top of the built-ins.

The built-in recognizers cover PERSON, LOCATION, ORGANIZATION (spaCy NER),
EMAIL_ADDRESS, PHONE_NUMBER, and IBAN_CODE. This module adds the two the persona
needs that Presidio does not ship: monetary amounts and the Croatian OIB. It is
also the single place to add more Croatian-specific patterns — see the module
docstring in main.py for how.
"""

from __future__ import annotations

from presidio_analyzer import Pattern, PatternRecognizer

# Organizations are handled by the built-in spaCy recognizer once ORG is added to
# the entity mapping (see main.py) — no custom recognizer needed for them.

# ── Monetary amounts ─────────────────────────────────────────────────────────
# €48,000 · EUR 12,000 · 30.000 EUR · $1,500 · 20.000 kn · 12000 euros
_MONEY_PATTERNS = [
    Pattern(
        name="currency_symbol_first",
        regex=r"(?<![\w.])(?:€|£|\$|USD|EUR|HRK)\s?\d[\d.,]*",
        score=0.7,
    ),
    Pattern(
        name="amount_currency_after",
        regex=r"(?<![\w.])\d[\d.,]*\s?(?:€|£|\$|USD|EUR|HRK|kn|euros?|dollars?|kuna)\b",
        score=0.7,
    ),
]

MONETARY_RECOGNIZER = PatternRecognizer(
    supported_entity="MONETARY_AMOUNT",
    name="monetary_amount_recognizer",
    patterns=_MONEY_PATTERNS,
    context=["fee", "budget", "price", "amount", "invoice", "cost", "paid", "pays"],
)

# ── Croatian OIB (osobni identifikacijski broj) ──────────────────────────────
# Exactly 11 digits. A bare 11-digit run is weak on its own, so the score is low
# and the surrounding word "OIB" boosts it via Presidio's context mechanism. A
# checksum-validating variant can replace this later without touching callers.
_OIB_PATTERN = Pattern(name="oib_11_digits", regex=r"(?<!\d)\d{11}(?!\d)", score=0.3)

OIB_RECOGNIZER = PatternRecognizer(
    supported_entity="CROATIAN_OIB",
    name="croatian_oib_recognizer",
    patterns=[_OIB_PATTERN],
    context=["OIB", "oib", "osobni", "identifikacijski"],
)

CUSTOM_RECOGNIZERS = [MONETARY_RECOGNIZER, OIB_RECOGNIZER]

# Every entity type the analyzer is asked to return. Extend this (and, if you add
# a new type, ENTITY_PREFIX in redactor.py) when adding recognizers.
SUPPORTED_ENTITIES = [
    "PERSON",
    "ORGANIZATION",
    "LOCATION",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "IBAN_CODE",
    "CREDIT_CARD",
    "MONETARY_AMOUNT",
    "CROATIAN_OIB",
]
