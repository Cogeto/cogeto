# Cogeto inbound mail server — Haraka, receive-only (Session O4, decision 0028;
# roadmap D2). One more container in the single-tenant deployment: it accepts
# forwarded mail for the instance's inbound address, applies recipient/size/rate
# hygiene, and hands the full raw message to the app over an internal
# authenticated HTTP endpoint. It NEVER sends (outbound disabled). No dependency
# on the TypeScript workspace.
#
# Base image PINNED BY DIGEST (QS-25); the tag is kept in the comment. Update
# procedure: docs/operations/image-pins.md.
# node:22-alpine
FROM node@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

ENV NODE_ENV=production

WORKDIR /app

# Deps first (cache-friendly): Haraka + its constants module.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

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
