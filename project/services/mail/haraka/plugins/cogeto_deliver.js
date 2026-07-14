'use strict';

// Delivery-to-app queue hook (decision 0028 ruling 7): at queue time, POST the
// full raw RFC822 to Cogeto's internal, authenticated intake endpoint over HTTP
// (never a shared filesystem) and translate the app's HTTP verdict into the SMTP
// response so the sending server sees the acceptance decision during the
// transaction. The app is the AUTHORITATIVE gate (allowlist + owner + size);
// this plugin only surfaces its verdict.
//
//   200 -> 250 queued (accepted)      403 -> 550 refused (allowlist / recipient)
//   413 -> 552 too large              5xx / network -> 451 try again later
//
// This is the ONLY egress from the receive-only mail service. Haraka runs
// plugins in a sandbox WITHOUT a global `fetch`, so we use node's http/https.

const { Writable } = require('stream');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const constants = require('haraka-constants');

exports.hook_queue = function (next, connection) {
  const plugin = this;
  const txn = connection.transaction;
  const rawUrl = process.env.COGETO_INTAKE_URL;
  const token = process.env.COGETO_MAIL_INTAKE_TOKEN;

  if (!rawUrl || !token) {
    connection.logerror(plugin, 'intake URL/token not configured — refusing softly');
    return next(constants.DENYSOFT, 'inbound intake temporarily unavailable');
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    connection.logerror(plugin, 'invalid COGETO_INTAKE_URL: ' + err.message);
    return next(constants.DENYSOFT, 'inbound intake misconfigured');
  }
  const transport = url.protocol === 'https:' ? https : http;

  const chunks = [];
  const collector = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });

  collector.on('finish', () => {
    const raw = Buffer.concat(chunks);
    const mailFrom =
      txn.mail_from && typeof txn.mail_from.address === 'function' ? txn.mail_from.address() : '';
    const rcptTo =
      txn.rcpt_to && txn.rcpt_to[0] && typeof txn.rcpt_to[0].address === 'function'
        ? txn.rcpt_to[0].address()
        : '';

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'message/rfc822',
          'content-length': raw.length,
          authorization: 'Bearer ' + token,
          'x-cogeto-mail-from': mailFrom || '',
          'x-cogeto-rcpt-to': rcptTo || '',
        },
      },
      (res) => {
        // Drain the body so the socket frees; the status is the verdict.
        res.on('data', () => {});
        res.on('end', () => {
          const status = res.statusCode;
          if (status === 200) return next(constants.OK);
          if (status === 413) return next(constants.DENY, 'message too large');
          if (status === 403) return next(constants.DENY, 'sender not accepted');
          if (status >= 500) return next(constants.DENYSOFT, 'temporary intake failure');
          return next(constants.DENY, 'message rejected');
        });
      },
    );
    req.setTimeout(20_000, () => req.destroy(new Error('intake request timeout')));
    req.on('error', (err) => {
      connection.logerror(plugin, 'intake POST failed: ' + err.message);
      return next(constants.DENYSOFT, 'temporary intake failure');
    });
    req.end(raw);
  });

  // message_stream yields the complete message with CRLF line endings.
  txn.message_stream.pipe(collector, { line_endings: '\r\n' });
};
