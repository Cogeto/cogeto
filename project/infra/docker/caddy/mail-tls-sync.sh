#!/bin/sh
# cogeto-mail-tls-sync — the producing half of inbound-mail TLS (issue #566).
#
# The edge obtains and renews the Let's Encrypt certificate for the mail
# hostname (the ACME-only vhost in the deploy Caddyfile). This loop presents
# that certificate to the mail service by copying it into the dedicated
# `mail-tls` volume, which is the ONLY thing the internet-facing Haraka
# container mounts. It runs from the edge image, in its own container under the
# `mail` compose profile, so:
#
#   • the mail container still sees ONLY its own certificate and key, never
#     Caddy's whole certificate store (that boundary was chosen deliberately
#     when the volume was introduced and is not widened here);
#   • nothing needs the Docker socket, which on an internet-facing single-tenant
#     box is root-equivalent and would be a far worse trade than the problem it
#     solves;
#   • no host cron, no systemd unit, nothing outside the compose file the
#     operator script re-fetches on upgrade — so the mechanism survives an
#     upgrade for the same reason the vhost does.
#
# It runs on every renewal, not once at install: the loop re-reads the source
# every SYNC_INTERVAL_SECONDS and copies only when the material actually
# changed. The mail container notices the change itself and restarts to load it
# (project/services/mail/docker-entrypoint.sh); that is why nothing here needs
# to be able to restart another container.
#
# A manual copy was the documented alternative and is exactly the failure this
# exists to remove: the certificate renews every 60 days, silently, and a
# forgotten copy downgrades inbound mail to cleartext with nothing saying so.
set -eu

CERT_ROOT="${COGETO_CADDY_DATA_DIR:-/data}/caddy/certificates"
DEST_DIR="${COGETO_MAIL_TLS_DIR:-/mail-tls}"
# The mail image runs as the base image's non-root `node` user (uid 1000). The
# entrypoint's readability test runs AS THAT USER, so root-only material is not
# a permission error the operator sees: it silently means no STARTTLS.
MAIL_UID="${COGETO_MAIL_UID:-1000}"
MAIL_GID="${COGETO_MAIL_GID:-1000}"
SYNC_INTERVAL_SECONDS="${COGETO_MAIL_TLS_SYNC_INTERVAL_SECONDS:-300}"

# `mail.<domain>`, from COGETO_MAIL_TLS_SITE — the operator script's
# derive_mx_host, the same value the Caddyfile's ACME vhost and the DNS
# checklist use. One derivation, carried in one variable.
HOST="${COGETO_MAIL_TLS_SITE:-}"

say() { printf 'cogeto-mail-tls-sync: %s\n' "$*"; }

if [ -z "$HOST" ]; then
  say "COGETO_MAIL_TLS_SITE is not set — nothing to propagate. Enable email"
  say "capture with 'cogeto features enable mail', which sets it to the mail"
  say "hostname and adds the DNS record the certificate needs."
  # Idle rather than exit: exiting would make compose report the service as
  # failed on an instance that is simply not using email capture.
  while :; do sleep 3600; done
fi

# Caddy stores each certificate under an issuer-named directory
# (acme-v02.api.letsencrypt.org-directory, or the fallback issuer's), so the
# issuer is a glob rather than a constant.
find_source() {  # find_source EXTENSION → path, or empty
  for candidate in "$CERT_ROOT"/*/"$HOST"/"$HOST.$1"; do
    [ -r "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  done
  return 0
}

fingerprint() {  # fingerprint FILE... → one hash over the whole set
  cat "$@" 2>/dev/null | sha256sum | cut -d' ' -f1
}

say "watching ${CERT_ROOT}/*/${HOST} → ${DEST_DIR} every ${SYNC_INTERVAL_SECONDS}s"

announced_missing=0
while :; do
  src_cert="$(find_source crt)"
  src_key="$(find_source key)"

  if [ -n "$src_cert" ] && [ -n "$src_key" ]; then
    announced_missing=0
    src_hash="$(fingerprint "$src_cert" "$src_key")"
    dst_hash=""
    if [ -r "$DEST_DIR/cert.pem" ] && [ -r "$DEST_DIR/key.pem" ]; then
      dst_hash="$(fingerprint "$DEST_DIR/cert.pem" "$DEST_DIR/key.pem")"
    fi
    if [ "$src_hash" != "$dst_hash" ]; then
      # Write to a temp name and rename, so the mail container never reads a
      # half-written PEM and restarts on garbage.
      cp "$src_cert" "$DEST_DIR/cert.pem.tmp"
      cp "$src_key" "$DEST_DIR/key.pem.tmp"
      chown "$MAIL_UID:$MAIL_GID" "$DEST_DIR/cert.pem.tmp" "$DEST_DIR/key.pem.tmp"
      chmod 0644 "$DEST_DIR/cert.pem.tmp"
      chmod 0640 "$DEST_DIR/key.pem.tmp"
      mv "$DEST_DIR/cert.pem.tmp" "$DEST_DIR/cert.pem"
      mv "$DEST_DIR/key.pem.tmp" "$DEST_DIR/key.pem"
      if [ -z "$dst_hash" ]; then
        say "installed the certificate for ${HOST} — the mail service picks it up and advertises STARTTLS"
      else
        say "the certificate for ${HOST} changed (renewal) — reinstalled; the mail service restarts to load it"
      fi
    fi
  elif [ "$announced_missing" -eq 0 ]; then
    announced_missing=1
    say "no certificate for ${HOST} in the edge's store yet. Caddy keeps retrying"
    say "ACME until the ${HOST} A record resolves to this host; until then"
    say "inbound mail runs in cleartext and 'cogeto status' says so."
  fi

  sleep "$SYNC_INTERVAL_SECONDS"
done
