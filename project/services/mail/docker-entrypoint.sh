#!/bin/sh
# Cogeto inbound Haraka entrypoint (decision 0028): derive the per-tenant
# accepted domain and the size cap from the provisioning env, then start the
# receive-only SMTP server. Everything else is baked into the config dir.
set -eu

ADDR="${COGETO_MAIL_INBOUND_ADDRESS:-capture@in.localhost}"
DOMAIN="${ADDR#*@}"
MAX_BYTES="${COGETO_MAIL_MAX_BYTES:-26214400}"
# The mounted instance TLS certificate for inbound STARTTLS (GAP-2). The deploy
# stack mounts the Caddy-obtained cert/key here read-only; a dev box leaves it
# unset and STARTTLS is simply not advertised.
TLS_CERT="${COGETO_MAIL_TLS_CERT:-/app/tls/cert.pem}"
TLS_KEY="${COGETO_MAIL_TLS_KEY:-/app/tls/key.pem}"

CONFIG_DIR=/app/haraka/config

# The domain Haraka accepts mail FOR and greets AS (per-tenant). `host_list`
# tells Haraka core which domains are local (its relay-deny / local-delivery
# determination reads it) — cogeto_rcpt is still the authoritative recipient
# gate, but host_list is not dead config, so it stays (GAP-16 reviewed).
printf '%s\n' "$DOMAIN" > "$CONFIG_DIR/host_list"
printf '%s\n' "$DOMAIN" > "$CONFIG_DIR/me"
# Hard message-size cap (SMTP SIZE) — the app enforces the same value authoritatively.
printf '%s\n' "$MAX_BYTES" > "$CONFIG_DIR/databytes"

# STARTTLS (GAP-2): enable the tls plugin ONLY when a certificate is present, so
# a cert-less dev instance still boots. Haraka's tls plugin reads config/tls.ini
# for the PEM paths and advertises STARTTLS on the inbound listener.
if [ -r "$TLS_CERT" ] && [ -r "$TLS_KEY" ]; then
  cat > "$CONFIG_DIR/tls.ini" <<EOF
[main]
key=${TLS_KEY}
cert=${TLS_CERT}
EOF
  # Append the tls plugin once (idempotent across restarts of the same container).
  grep -qxF 'tls' "$CONFIG_DIR/plugins" || printf '\ntls\n' >> "$CONFIG_DIR/plugins"
  echo "cogeto-mail: STARTTLS enabled (cert=${TLS_CERT})"
else
  echo "cogeto-mail: no TLS certificate mounted — STARTTLS NOT advertised (dev/cert-less)"
fi

echo "cogeto-mail: inbound address=${ADDR} domain=${DOMAIN} max_bytes=${MAX_BYTES}"
echo "cogeto-mail: intake=${COGETO_INTAKE_URL:-<unset>} (receive-only; outbound disabled)"

exec node /app/node_modules/haraka/bin/haraka -c /app/haraka
