#!/bin/sh
# Cogeto inbound Haraka entrypoint (decision 0028): derive the per-tenant
# accepted domain and the size cap from the provisioning env, then start the
# receive-only SMTP server. Everything else is baked into the config dir.
set -eu

ADDR="${COGETO_MAIL_INBOUND_ADDRESS:-capture@in.localhost}"
DOMAIN="${ADDR#*@}"
MAX_BYTES="${COGETO_MAIL_MAX_BYTES:-26214400}"

CONFIG_DIR=/app/haraka/config

# The domain Haraka accepts mail FOR (host_list) and greets AS (me). Per-tenant.
printf '%s\n' "$DOMAIN" > "$CONFIG_DIR/host_list"
printf '%s\n' "$DOMAIN" > "$CONFIG_DIR/me"
# Hard message-size cap (SMTP SIZE) — the app enforces the same value authoritatively.
printf '%s\n' "$MAX_BYTES" > "$CONFIG_DIR/databytes"

echo "cogeto-mail: inbound address=${ADDR} domain=${DOMAIN} max_bytes=${MAX_BYTES}"
echo "cogeto-mail: intake=${COGETO_INTAKE_URL:-<unset>} (receive-only; outbound disabled)"

exec node /app/node_modules/Haraka/bin/haraka -c /app/haraka
