#!/bin/sh
# Cogeto inbound Haraka entrypoint: derive the per-tenant
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
# How often to notice a renewed certificate. Short enough that shutdown is
# never delayed past Docker's stop grace period (the trap below fires between
# sleeps), long enough that the check is free. Not configurable: a knob nobody
# would turn is one more variable the two compose files can disagree about.
TLS_WATCH_INTERVAL=5

CONFIG_DIR=/app/haraka/config

# The domain Haraka accepts mail FOR and greets AS (per-tenant). `host_list`
# tells Haraka core which domains are local (its relay-deny / local-delivery
# determination reads it) — cogeto_rcpt is still the authoritative recipient
# gate, but host_list is not dead config, so it stays (GAP-16 reviewed).
printf '%s\n' "$DOMAIN" > "$CONFIG_DIR/host_list"
printf '%s\n' "$DOMAIN" > "$CONFIG_DIR/me"
# Hard message-size cap (SMTP SIZE) — the app enforces the same value authoritatively.
printf '%s\n' "$MAX_BYTES" > "$CONFIG_DIR/databytes"

# A hash over the TLS material as this process sees it, or empty when there is
# none. The readability test runs AS THE NON-ROOT USER this container runs as,
# which is the point: material readable only by root is indistinguishable here
# from no material at all, and the result is a silent cleartext downgrade.
tls_fingerprint() {
  if [ -r "$TLS_CERT" ] && [ -r "$TLS_KEY" ]; then
    cat "$TLS_CERT" "$TLS_KEY" | sha256sum | cut -d' ' -f1
  fi
}

# STARTTLS: enable the tls plugin ONLY when a certificate is present, so a
# cert-less dev instance still boots. Haraka's tls plugin reads config/tls.ini
# for the PEM paths and advertises STARTTLS on the inbound listener.
TLS_FINGERPRINT="$(tls_fingerprint)"
if [ -n "$TLS_FINGERPRINT" ]; then
  # Diffie-Hellman parameters for the DHE cipher suites. Haraka generates
  # these itself if tls.ini does not name a file, by spawning `openssl dhparam`
  # under a 30-second timeout on plugin load; doing it here instead keeps the
  # cost bounded, logged, and out of a race with that timeout. Generated once
  # per container (a restart-to-load-a-renewal reuses it) and per instance:
  # a parameter set baked into the image would be shared by every deployment,
  # which is exactly what makes a DH group worth precomputing against.
  if [ ! -s "$CONFIG_DIR/dhparams.pem" ]; then
    echo "cogeto-mail: generating 2048-bit DH parameters (once per container; this takes a moment)"
    openssl dhparam -out "$CONFIG_DIR/dhparams.pem" 2048 2>/dev/null
  fi
  cat > "$CONFIG_DIR/tls.ini" <<EOF
[main]
key=${TLS_KEY}
cert=${TLS_CERT}
dhparam=dhparams.pem
EOF
  # Append the tls plugin once (idempotent across restarts of the same container).
  grep -qxF 'tls' "$CONFIG_DIR/plugins" || printf '\ntls\n' >> "$CONFIG_DIR/plugins"
  echo "cogeto-mail: STARTTLS enabled (cert=${TLS_CERT})"
else
  # Not a footnote: this is the cleartext posture, and it used to be one log
  # line nobody read. `cogeto status` and the `mail` capability now report it
  # too, so a downgrade is visible rather than discovered by a customer.
  echo "cogeto-mail: no readable TLS certificate at ${TLS_CERT} — STARTTLS NOT advertised, inbound mail is CLEARTEXT"
fi

echo "cogeto-mail: inbound address=${ADDR} domain=${DOMAIN} max_bytes=${MAX_BYTES}"
echo "cogeto-mail: intake=${COGETO_INTAKE_URL:-<unset>} (receive-only; outbound disabled)"

# Load a renewed certificate without a human (issue #566). Haraka reads the PEM
# files once at startup, so picking up a renewal means restarting: the edge's
# mail-tls-sync sidecar replaces the material in the mounted volume, this loop
# notices, and exiting lets compose's `restart: unless-stopped` bring the
# listener straight back with the new certificate. Restarting is deliberately
# conditional on the material CHANGING, so a steady state restarts nothing.
#
# Haraka runs as a child rather than via exec so this loop can exist; the trap
# keeps `docker stop` clean by forwarding SIGTERM to it.
node /app/node_modules/haraka/bin/haraka -c /app/haraka &
HARAKA_PID=$!
trap 'kill -TERM "$HARAKA_PID" 2>/dev/null || true' TERM INT

while kill -0 "$HARAKA_PID" 2>/dev/null; do
  sleep "$TLS_WATCH_INTERVAL" || break
  if [ "$(tls_fingerprint)" != "$TLS_FINGERPRINT" ]; then
    echo "cogeto-mail: the TLS material changed — restarting to load it"
    kill -TERM "$HARAKA_PID" 2>/dev/null || true
    wait "$HARAKA_PID" 2>/dev/null || true
    exit 0
  fi
done

wait "$HARAKA_PID"
