# One multi-stage image, two entrypoints.
# Build context: the repo root. Targets: runtime (app/worker/migrate), caddy (edge + SPA).
#
# Base images are PINNED BY DIGEST so builds are reproducible and cannot
# silently drift under a floating tag. The human-readable tag is kept in a
# comment; to update, run `docker buildx imagetools inspect <image>:<tag>` and
# replace the digest (see docs/operations/image-pins.md).

# ── Stage 1a: install all workspace dependencies ─────────────────────────────
# node:22-alpine
FROM node@sha256:bde0dae02f2b12d2bce5ee72b2432f0e511767b7b2dc4dd3b064df11ae422fee AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY project/shared/package.json project/shared/package.json
COPY project/src/package.json project/src/package.json
COPY project/web/package.json project/web/package.json
RUN npm ci

# ── Stage 1b: compile backend (NestJS via tsc) and frontend (Vite static) ────
FROM deps AS build
COPY tsconfig.base.json ./
COPY project/shared project/shared
COPY project/src project/src
COPY project/web project/web
COPY project/prompts project/prompts
COPY project/demo project/demo
RUN npm run build

# ── Stage 2: slim runtime — app, worker, and migrate run from this image ─────
# node:22-alpine
FROM node@sha256:bde0dae02f2b12d2bce5ee72b2432f0e511767b7b2dc4dd3b064df11ae422fee AS runtime
ENV NODE_ENV=production
WORKDIR /repo
# The reading ladder's local tiers (V2.1 item 4.1). Both are CPU-only and run
# IN-INSTANCE: a scanned page is rendered and read here, and nothing about it
# leaves the box unless the operator has configured a vision tier and the page
# needs one.
#   poppler-utils  pdftoppm, which renders a PDF page to a PNG at a chosen DPI.
#                  Rendering at a bounded DPI is also what bounds image size,
#                  which is why no image-processing library is needed anywhere.
#   tesseract-ocr  the OCR engine, plus the language data for the three
#                  languages the product supports. Each pack is a few MB; they
#                  are listed explicitly rather than pulling `tesseract-ocr-data-all`,
#                  which would add a hundred languages nobody asked for.
RUN apk add --no-cache \
      poppler-utils \
      tesseract-ocr \
      tesseract-ocr-data-eng \
      tesseract-ocr-data-hrv \
      tesseract-ocr-data-deu
COPY package.json package-lock.json ./
COPY project/shared/package.json project/shared/package.json
COPY project/src/package.json project/src/package.json
RUN npm ci -w @cogeto/server --omit=dev && npm cache clean --force
COPY --from=build /repo/project/shared/dist project/shared/dist
COPY --from=build /repo/project/src/dist project/src/dist
# Dev-only entrypoints never ship: seed-object/seed-orphan plant demo fixtures
#; demo-seed/demo-reset run the Ana sandbox from the BUILD image
#. The sweep entrypoint stays — it is an ops tool, not a
# fixture. The demo/ LIBRARY stays — the worker's scheduled reset imports it.
#
# The EVALUATION harness joins them (issue #594): eval / eval-chat and their
# two support modules, plus the two smoke tools, are run by npm scripts from a
# source checkout (`npm run eval`, `npm run eval:chat`, `npm run gateway:smoke`,
# `npm run vector:smoke`) and by CI. No compose file, no documented operator
# procedure and no runtime code path names them, and their corpora are not in
# this image at all — so on a customer instance they are dead weight that reads
# like a supported tool. The two documented one-shot repair tools
# (erase-task-conclusions, dedupe-file-sources) stay: the runbook tells an
# operator to run them.
#
# deployment-hardening.spec.ts derives this list from the source tree, so a new
# seed-/demo-/eval-/-smoke entrypoint fails the build until it is named here.
RUN rm -f project/src/dist/entrypoints/seed-object.js project/src/dist/entrypoints/seed-object.d.ts project/src/dist/entrypoints/seed-object.js.map \
    project/src/dist/entrypoints/seed-orphan.js project/src/dist/entrypoints/seed-orphan.d.ts project/src/dist/entrypoints/seed-orphan.js.map \
    project/src/dist/entrypoints/demo-seed.js project/src/dist/entrypoints/demo-seed.d.ts project/src/dist/entrypoints/demo-seed.js.map \
    project/src/dist/entrypoints/demo-reset.js project/src/dist/entrypoints/demo-reset.d.ts project/src/dist/entrypoints/demo-reset.js.map \
    project/src/dist/entrypoints/eval.js project/src/dist/entrypoints/eval.d.ts project/src/dist/entrypoints/eval.js.map \
    project/src/dist/entrypoints/eval-chat.js project/src/dist/entrypoints/eval-chat.d.ts project/src/dist/entrypoints/eval-chat.js.map \
    project/src/dist/entrypoints/eval-cache.js project/src/dist/entrypoints/eval-cache.d.ts project/src/dist/entrypoints/eval-cache.js.map \
    project/src/dist/entrypoints/eval-env.js project/src/dist/entrypoints/eval-env.d.ts project/src/dist/entrypoints/eval-env.js.map \
    project/src/dist/entrypoints/gateway-smoke.js project/src/dist/entrypoints/gateway-smoke.d.ts project/src/dist/entrypoints/gateway-smoke.js.map \
    project/src/dist/entrypoints/vector-smoke.js project/src/dist/entrypoints/vector-smoke.d.ts project/src/dist/entrypoints/vector-smoke.js.map
# Reviewable SQL migrations (read by the migrate entrypoint), versioned prompt
# artifacts (read by the model-gateway prompt loader, spec §12.3), and the Ana sandbox
# corpus + document (read by the worker's scheduled reset —).
COPY --from=build /repo/project/src/migrations project/src/migrations
COPY --from=build /repo/project/prompts project/prompts
COPY --from=build /repo/project/demo project/demo
# Findings-report rendering inputs (V2.3 item 6.2): the vendored report fonts
# (DejaVu, full hr/de/fr glyph coverage, license alongside), the canonical
# brand assets (the logo is drawn from the provided file), and the published
# trust-score artifacts the report looks its model configuration up in.
# COPY preserves source permissions and the brand files are 0600 in the repo;
# the runtime user is `node`, so read (and directory traversal) must be added
# explicitly. `a+rX` adds read everywhere and execute only where it means
# traversal.
COPY project/fonts project/fonts
COPY assets/brand assets/brand
COPY eval/trust-scores eval/trust-scores
RUN chmod -R a+rX project/fonts assets/brand eval/trust-scores
USER node
# app is the default; worker and migrate override the command in compose
CMD ["node", "project/src/dist/entrypoints/app.js"]

# ── Edge: Caddy with the built SPA baked in ──────────────────────────────────
# caddy:2-alpine
FROM caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS caddy
COPY project/infra/docker/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/project/web/dist /srv
# Inbound-mail TLS propagation (issue #566). Not part of the edge's own job:
# the deploy stack runs a SECOND container from this image, under the `mail`
# profile, with this as its entrypoint. It lives here because this image is the
# one that owns the certificate store, and because reusing a published, signed
# release image beats publishing a fifth one for twenty lines of shell.
COPY project/infra/docker/caddy/mail-tls-sync.sh /usr/local/bin/cogeto-mail-tls-sync
RUN chmod 0755 /usr/local/bin/cogeto-mail-tls-sync

# ── Consoles edge (profile `consoles`): the infra dashboards (MinIO,
# Qdrant) + the S3 presign origin, served ONLY here so they never answer on the
# public 443 listener by Host header. Compose binds this to 127.0.0.1 only.
# caddy:2-alpine
FROM caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS caddy-consoles
COPY project/infra/docker/caddy/Caddyfile.consoles /etc/caddy/Caddyfile
