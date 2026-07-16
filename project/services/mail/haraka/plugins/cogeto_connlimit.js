'use strict';

// In-process per-remote-host connection concurrency limit (GAP-1). The bundled
// haraka-plugin-limit requires a Redis backend and crashes init_master without
// one, so this single-tenant receive-only server uses a tiny in-memory limiter
// instead: one worker process (smtp.ini nodes=1) means an in-process Map is
// exact and needs no external service. It caps simultaneous connections from a
// single remote host — DoS hygiene at the SMTP layer. The real throttle on the
// EXPENSIVE path (ingestion/model spend) is the app-side per-sender intake rate
// cap (SEC-2); this is belt-and-suspenders at the connection layer.

const constants = require('haraka-constants');

// remote ip -> current concurrent connection count (this process).
const active = new Map();

exports.register = function () {
  const cfg = this.config.get('cogeto_connlimit.ini') || {};
  const max = parseInt((cfg.main && cfg.main.max) || '3', 10);
  this.max = Number.isFinite(max) && max > 0 ? max : 3;
  this.loginfo('per-host connection concurrency limit = ' + this.max);
};

exports.hook_connect = function (next, connection) {
  const ip = (connection.remote && connection.remote.ip) || 'unknown';
  const n = active.get(ip) || 0;
  if (n >= this.max) {
    return next(constants.DENYSOFT, 'too many concurrent connections from your host');
  }
  active.set(ip, n + 1);
  connection.notes.cogeto_connlimit_ip = ip;
  return next();
};

// Release the slot when the connection ends (either hook fires depending on how
// the client closes); guarded so a doubled call cannot go negative.
function release(connection) {
  const ip = connection.notes && connection.notes.cogeto_connlimit_ip;
  if (!ip) return;
  connection.notes.cogeto_connlimit_ip = null;
  const n = (active.get(ip) || 1) - 1;
  if (n <= 0) active.delete(ip);
  else active.set(ip, n);
}

exports.hook_disconnect = function (next, connection) {
  release(connection);
  return next();
};

exports.hook_quit = function (next, connection) {
  release(connection);
  return next();
};
