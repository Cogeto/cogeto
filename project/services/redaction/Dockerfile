# Cogeto redaction sidecar — Python/Presidio, CPU-only (Addendum B.8; decision
# 0002 language boundary: Python ONLY where a local model runs, isolated behind
# the gateway seam). No dependency on the TypeScript workspace.
#
# Base image PINNED BY DIGEST and the spaCy NER model pinned to an exact version
# (QS-25) so the build is reproducible — a plain model fetch otherwise pulls the
# latest compatible model, a silent supply-chain drift. Update procedure:
# docs/operations/image-pins.md.
# python:3.12-slim
FROM python@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SPACY_MODEL=en_core_web_lg

WORKDIR /app

# Deps first (cache-friendly). We install from the fully hash-locked
# requirements.lock with --require-hashes (SEC-12): every wheel — including the
# whole transitive tree — is pinned by version AND verified by hash, so no
# transitive drift under the pinned base-image digest. requirements.txt stays as
# the human-readable top-level input the lock is compiled from.
# Then the NER model at a PINNED version (matches spacy 3.7.x); --no-deps keeps
# it hermetic (its only dependency, spacy, is already satisfied by the lock).
# en_core_web_lg gives the best CPU NER accuracy; to trade accuracy for ~half the
# RSS, pin en_core_web_md-3.7.1 instead and set SPACY_MODEL.
COPY requirements.txt requirements.lock ./
RUN pip install --require-hashes -r requirements.lock \
    && pip install --no-deps https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-3.7.1/en_core_web_lg-3.7.1-py3-none-any.whl

COPY app ./app

# Run as non-root; the service holds no state and needs no writable paths.
RUN useradd --create-home --uid 1000 redaction
USER redaction

EXPOSE 8080

# /health loads the model, so a container that cannot load it reports unhealthy —
# the gateway then fails closed rather than sending plaintext upstream.
HEALTHCHECK --interval=10s --timeout=5s --retries=12 --start-period=60s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health').status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
