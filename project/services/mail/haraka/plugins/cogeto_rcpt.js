'use strict';

// Recipient validation (decision 0028 ruling 6): accept mail ONLY for the
// instance's single configured inbound address; refuse every other recipient at
// RCPT with SMTP 550 so the sending server gets a clear rejection during the
// transaction. The address is per-tenant and set at provision time via
// COGETO_MAIL_INBOUND_ADDRESS (the app enforces the same value authoritatively).

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
  return next(constants.DENY, 'relaying denied — unknown recipient');
};
