# Cogeto inbound mail server — Haraka, receive-only (
# roadmap D2). One more container in the single-tenant deployment: it accepts
# forwarded mail for the instance's inbound address, applies recipient/size/rate
# hygiene, and hands the full raw message to the app over an internal
# authenticated HTTP endpoint. It NEVER sends (outbound disabled). No dependency
# on the TypeScript workspace.
#
# Base image PINNED BY DIGEST; the tag is kept in the comment. Update
# procedure: docs/operations/image-pins.md.
# node:22-alpine
FROM node@sha256:0473e7dc433a1310f436edee02aa79737ec78a4b345433ab0963d4a256f9ad85

ENV NODE_ENV=production

WORKDIR /app

# Deps first (cache-friendly): install from the committed lockfile with `npm ci`
# so the whole transitive tree is reproducible (SEC-9) — this container parses
# hostile internet input, so it must not float its deps at each build.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# The receive-only config dir (plugins + core config) and the entrypoint.
COPY haraka ./haraka
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Run as the base image's non-root `node` user (uid 1000); Haraka listens on
# 2525 inside the container (the deployment maps the standard inbound port
# 25 -> 2525), so no privileged bind is needed. The user must own the config dir
# (the entrypoint writes host_list / me / databytes from env at start).
RUN chown -R node:node /app
USER node

EXPOSE 2525

# Liveness: the SMTP listener must be accepting connections.
HEALTHCHECK --interval=10s --timeout=5s --retries=12 --start-period=20s \
    CMD node -e "require('net').connect(2525,'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})"

ENTRYPOINT ["./docker-entrypoint.sh"]
