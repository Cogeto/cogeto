# Cogeto redaction sidecar — Python/Presidio, CPU-only (Addendum B.8; decision
# 0002 language boundary: Python ONLY where a local model runs, isolated behind
# the gateway seam). No dependency on the TypeScript workspace.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SPACY_MODEL=en_core_web_lg

WORKDIR /app

# Deps first (cache-friendly), then the NER model. en_core_web_lg gives the best
# CPU NER accuracy; swap to en_core_web_md via SPACY_MODEL to trade accuracy for
# ~half the RSS if the ~1 GB target is tight.
COPY requirements.txt ./
RUN pip install -r requirements.txt \
    && python -m spacy download en_core_web_lg

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
