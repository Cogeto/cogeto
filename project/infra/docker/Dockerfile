# One multi-stage image, two entrypoints (decision 0002).
# Build context: the repo root. Targets: runtime (app/worker/migrate), caddy (edge + SPA).
#
# Base images are PINNED BY DIGEST (QS-25) so builds are reproducible and cannot
# silently drift under a floating tag. The human-readable tag is kept in a
# comment; to update, run `docker buildx imagetools inspect <image>:<tag>` and
# replace the digest (see docs/operations/image-pins.md).

# ── Stage 1a: install all workspace dependencies ─────────────────────────────
# node:22-alpine
FROM node@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS deps
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
FROM node@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY project/shared/package.json project/shared/package.json
COPY project/src/package.json project/src/package.json
RUN npm ci -w @cogeto/server --omit=dev && npm cache clean --force
COPY --from=build /repo/project/shared/dist project/shared/dist
COPY --from=build /repo/project/src/dist project/src/dist
# Dev-only entrypoints never ship: seed-object/seed-orphan plant demo fixtures
# (Session F1); demo-seed/demo-reset run the Ana sandbox from the BUILD image
# (§B.9, decision 0022). The sweep entrypoint stays — it is an ops tool, not a
# fixture. The demo/ LIBRARY stays — the worker's scheduled reset imports it.
RUN rm -f project/src/dist/entrypoints/seed-object.js project/src/dist/entrypoints/seed-object.d.ts project/src/dist/entrypoints/seed-object.js.map \
    project/src/dist/entrypoints/seed-orphan.js project/src/dist/entrypoints/seed-orphan.d.ts project/src/dist/entrypoints/seed-orphan.js.map \
    project/src/dist/entrypoints/demo-seed.js project/src/dist/entrypoints/demo-seed.d.ts project/src/dist/entrypoints/demo-seed.js.map \
    project/src/dist/entrypoints/demo-reset.js project/src/dist/entrypoints/demo-reset.d.ts project/src/dist/entrypoints/demo-reset.js.map
# Reviewable SQL migrations (read by the migrate entrypoint), versioned prompt
# artifacts (read by the model-gateway prompt loader, §B.7), and the Ana sandbox
# corpus + document (read by the worker's scheduled reset — decision 0022).
COPY --from=build /repo/project/src/migrations project/src/migrations
COPY --from=build /repo/project/prompts project/prompts
COPY --from=build /repo/project/demo project/demo
USER node
# app is the default; worker and migrate override the command in compose
CMD ["node", "project/src/dist/entrypoints/app.js"]

# ── Edge: Caddy with the built SPA baked in ──────────────────────────────────
# caddy:2-alpine
FROM caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS caddy
COPY project/infra/docker/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/project/web/dist /srv

# ── Consoles edge (profile `consoles`, QS-4): the infra dashboards (MinIO,
# Qdrant) + the S3 presign origin, served ONLY here so they never answer on the
# public 443 listener by Host header. Compose binds this to 127.0.0.1 only.
# caddy:2-alpine
FROM caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS caddy-consoles
COPY project/infra/docker/caddy/Caddyfile.consoles /etc/caddy/Caddyfile
