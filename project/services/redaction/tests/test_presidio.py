"""Real-detection tests — exercise Presidio + the spaCy model end to end through
the HTTP endpoints. Skipped automatically where the model is not installed (so
the pure-logic suite still runs anywhere); run inside the built image:

    docker compose --profile redaction run --rm --entrypoint \
      sh redaction -c "pip install pytest httpx && pytest -q project/... "  # or:
    pytest project/services/redaction/tests -q      # with deps installed locally
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

pytest.importorskip("presidio_analyzer")
pytest.importorskip("fastapi.testclient")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)


def test_health_ok():
    res = client.get("/health")
    assert res.status_code == 200 and res.json()["status"] == "ok"


def test_pseudonymize_detects_and_reidentifies():
    text = "Email Ana Kovac at ana@adriaticfoods.hr about the EUR 12,000 fee."
    res = client.post("/pseudonymize", json={"text": text}).json()
    # The name, email, and amount must not survive in the redacted text.
    assert "Ana Kovac" not in res["text"]
    assert "ana@adriaticfoods.hr" not in res["text"]
    assert "12,000" not in res["text"]
    # Round-trips exactly through /reidentify with the returned mapping.
    back = client.post(
        "/reidentify", json={"text": res["text"], "mapping": res["mapping"]}
    ).json()
    assert back["text"] == text


def test_consistent_within_call():
    text = "Marko met Marko and then Marko left."
    res = client.post("/pseudonymize", json={"text": text}).json()
    # One pseudonym for Marko, used three times.
    marko_pseudonyms = {p for p, o in res["mapping"].items() if o == "Marko"}
    assert len(marko_pseudonyms) == 1
    assert res["text"].count(next(iter(marko_pseudonyms))) == 3
