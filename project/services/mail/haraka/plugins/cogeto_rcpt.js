'use strict';

// Recipient validation: accept mail ONLY for the
// instance's single configured inbound address, bare or plus-tagged
// (capture+alias@instance routes the alias to a space; the app resolves and
// enforces the routing authoritatively, docs/features/spaces.md section 6c);
// refuse every other recipient at RCPT with SMTP 550 so the sending server
// gets a clear rejection during the transaction. The address is per-tenant
// and set at provision time via COGETO_MAIL_INBOUND_ADDRESS.

const constants = require('haraka-constants');

exports.hook_rcpt = function (next, connection, params) {
  const rcpt = params[0];
  // Haraka <=3.1 exposes rcpt.address as a method; >=3.2 (@haraka/email-address)
  // as a string property. Handle both so an engine upgrade can never turn this
  // gate into a deny-all.
  const rawAddress = rcpt && (typeof rcpt.address === 'function' ? rcpt.address() : rcpt.address);
  const address = (rawAddress || '').toLowerCase();
  const want = (process.env.COGETO_MAIL_INBOUND_ADDRESS || '').toLowerCase();

  if (!want) {
    // Unconfigured instance is closed by default (ruling 1).
    return next(constants.DENY, 'inbound mail is not configured for this host');
  }
  if (address === want) return next(constants.OK);
  // A plus-tagged variant of the configured address: local+tag@domain. The
  // tag charset mirrors the app's alias rule (letters, digits, dot, dash,
  // underscore); anything else stays refused here, cheaply, at RCPT.
  const at = want.indexOf('@');
  if (at > 0) {
    const local = want.slice(0, at);
    const domain = want.slice(at);
    if (
      address.startsWith(local + '+') &&
      address.endsWith(domain) &&
      /^[a-z0-9._-]{1,64}$/.test(address.slice(local.length + 1, address.length - domain.length))
    ) {
      return next(constants.OK);
    }
  }
  return next(constants.DENY, 'relaying denied — unknown recipient');
};
