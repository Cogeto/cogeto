"""Pure pseudonymization logic (no spaCy needed → fast, deterministic).

redaction_roundtrip and redaction_consistent (Addendum B.8) at the sidecar level.
Detection quality (Presidio) is validated separately by test_presidio.py, which
skips unless the model is installed.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from app.redactor import Span, pseudonymize, reidentify  # noqa: E402


def _span(text: str, phrase: str, entity: str, start: int = 0) -> Span:
    idx = text.index(phrase, start)
    return Span(idx, idx + len(phrase), entity)


def test_redaction_roundtrip():
    text = "Ana Kovač at Adriatic Foods confirmed the €48,000 budget for Marko."
    spans = [
        _span(text, "Ana Kovač", "PERSON"),
        _span(text, "Adriatic Foods", "ORGANIZATION"),
        _span(text, "€48,000", "MONETARY_AMOUNT"),
        _span(text, "Marko", "PERSON"),
    ]
    redacted, mapping = pseudonymize(text, spans)

    # No real entity survives.
    for leaked in ("Ana Kovač", "Adriatic Foods", "48,000", "Marko"):
        assert leaked not in redacted
    # Bracketed lowercase slots appear (see redactor.py).
    assert "[person1]" in redacted and "[company1]" in redacted and "[amount1]" in redacted
    # Reversible exactly.
    assert reidentify(redacted, mapping) == text


def test_redaction_consistent():
    text = "Ana Kovač emailed Ana Kovač about Marko; Marko then called Ana Kovač."
    spans = []
    for phrase in ("Ana Kovač", "Ana Kovač", "Marko", "Marko", "Ana Kovač"):
        start = spans[-1].end if spans else 0
        spans.append(_span(text, phrase, "PERSON", start))
    redacted, mapping = pseudonymize(text, spans)

    # Same surface → same pseudonym, everywhere in the payload.
    assert redacted.count("[person1]") == 3  # the three "Ana Kovač"
    assert redacted.count("[person2]") == 2  # the two "Marko"
    assert len(mapping) == 2
    assert reidentify(redacted, mapping) == text


def test_reidentify_does_not_confuse_person_1_and_person_10():
    mapping = {f"[person{i}]": f"Name{i}" for i in range(1, 12)}
    text = "[person1] and [person10] and [person11] met."
    assert reidentify(text, mapping) == "Name1 and Name10 and Name11 met."


def test_reidentify_leaves_a_users_own_bare_token_untouched():
    # A user's text that literally says "person1" (not a minted slot) is safe:
    # only the bracketed slot is ever swapped.
    mapping = {"[person1]": "Ana Kovač"}
    assert reidentify("person1 mentioned [person1].", mapping) == "person1 mentioned Ana Kovač."


def test_overlapping_spans_keep_the_longer():
    text = "Ana Kovač signed."
    spans = [_span(text, "Ana", "PERSON"), _span(text, "Ana Kovač", "PERSON")]
    redacted, mapping = pseudonymize(text, spans)
    assert redacted == "[person1] signed."
    assert mapping["[person1]"] == "Ana Kovač"
