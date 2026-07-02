# One multi-stage image, two entrypoints (decision 0002).
# Build context: the repo root. Targets: runtime (app/worker/migrate), caddy (edge + SPA).

# ── Stage 1a: install all workspace dependencies ─────────────────────────────
FROM node:22-alpine AS deps
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
RUN npm run build

# ── Stage 2: slim runtime — app, worker, and migrate run from this image ─────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY project/shared/package.json project/shared/package.json
COPY project/src/package.json project/src/package.json
RUN npm ci -w @cogeto/server --omit=dev && npm cache clean --force
COPY --from=build /repo/project/shared/dist project/shared/dist
COPY --from=build /repo/project/src/dist project/src/dist
# Reviewable SQL migrations (read by the migrate entrypoint) and versioned
# prompt artifacts (read by the model-gateway prompt loader, §B.7).
COPY --from=build /repo/project/src/migrations project/src/migrations
COPY --from=build /repo/project/prompts project/prompts
USER node
# app is the default; worker and migrate override the command in compose
CMD ["node", "project/src/dist/entrypoints/app.js"]

# ── Edge: Caddy with the built SPA baked in ──────────────────────────────────
FROM caddy:2-alpine AS caddy
COPY project/infra/docker/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/project/web/dist /srv
