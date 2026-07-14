#!/usr/bin/env node
// send-test-email.mjs — submit a fixture message to the local Cogeto inbound
// mail service over SMTP, WITHOUT real DNS (Session O4, decision 0028). Speaks
// raw SMTP over a TCP socket (no dependency). The final response to the DATA
// "." is the acceptance verdict Haraka relays from the app:
//   250 queued  → accepted (sender allowlisted)
//   550         → refused  (sender not on the allowlist / wrong recipient)
//   552         → refused  (too large)
//
// Usage:
//   node scripts/dev/send-test-email.mjs                 # sends BOTH demo messages
//   node scripts/dev/send-test-email.mjs --from a@b.hr   # send one message
//
// Options (all optional):
//   --host <h>        SMTP host           (default 127.0.0.1)
//   --port <p>        SMTP port           (default 25)
//   --to <addr>       inbound address     (default capture@in.localhost)
//   --from <addr>     envelope + header From (sends a single message)
//   --subject <s>     subject line        (default "Cogeto test")
//   --body <t>        text body           (default a short sentence)
//   --attach <path>   attach a file as a MIME part (built as multipart/mixed)
//
// To demonstrate BOTH paths, first allowlist a sender/domain in the UI
// (Settings → Email capture), then run without --from: the first message (from
// the allowlisted demo domain) is accepted and the second (a stranger) refused.

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key.startsWith('--')) {
      args[key.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const HOST = args.host ?? process.env.COGETO_MAIL_HOST ?? '127.0.0.1';
const PORT = Number(args.port ?? process.env.COGETO_MAIL_PORT ?? 25);
const TO = args.to ?? process.env.COGETO_MAIL_INBOUND_ADDRESS ?? 'capture@in.localhost';

/** Build one RFC822 message (multipart/mixed when an attachment is supplied). */
function buildMessage({ from, to, subject, body, attach }) {
  const date = new Date().toUTCString();
  const messageId = `<${Date.now()}.${Math.floor(Math.random() * 1e6)}@cogeto.test>`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];
  if (!attach) {
    headers.push('Content-Type: text/plain; charset=utf-8');
    return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
  }
  const boundary = `=_cogeto_${Date.now().toString(36)}`;
  const bytes = readFileSync(attach);
  const name = basename(attach);
  const b64 = bytes.toString('base64').replace(/(.{76})/g, '$1\r\n');
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  return (
    `${headers.join('\r\n')}\r\n\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/octet-stream; name="${name}"\r\n` +
    `Content-Disposition: attachment; filename="${name}"\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n${b64}\r\n\r\n` +
    `--${boundary}--\r\n`
  );
}

/** Drive one SMTP transaction, printing the transcript. Resolves with the code
 * of the final DATA response (the acceptance verdict). */
function sendOne({ from, to, subject, body, attach }) {
  const message = buildMessage({ from, to, subject, body, attach });
  const dotStuffed = message.replace(/\r\n\./g, '\r\n..');
  const steps = [
    `EHLO cogeto-dev`,
    `MAIL FROM:<${from}>`,
    `RCPT TO:<${to}>`,
    `DATA`,
    `${dotStuffed}\r\n.`,
    `QUIT`,
  ];

  const MESSAGE_STEP = 4; // steps index of the message body + "."

  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: HOST, port: PORT });
    let next = 0; // index of the next command to send
    let lastSent = -1; // index of the last command sent (-1 = awaiting greeting)
    let buffer = '';
    let finalCode = 0;

    socket.setEncoding('utf8');
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error('SMTP timeout'));
    });
    socket.on('error', reject);

    const sendNext = () => {
      if (next >= steps.length) return;
      const line = steps[next];
      process.stdout.write(`C: ${next === MESSAGE_STEP ? '<message body>.' : line}\n`);
      socket.write(line + '\r\n');
      lastSent = next;
      next += 1;
    };

    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\r\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        process.stdout.write(`S: ${line}\n`);
        // A complete SMTP reply's final line is "NNN <SP> ..." (not "NNN-").
        if (!/^\d{3} /.test(line)) continue;
        const code = Number(line.slice(0, 3));
        // The verdict is the reply to the message ("."); but a refusal can also
        // land earlier (a 4xx/5xx at MAIL/RCPT — e.g. a wrong recipient). Record
        // the FIRST decisive code: an early rejection wins over the noise a
        // rejected transaction produces for the later DATA/body commands.
        if (finalCode === 0 && (lastSent === MESSAGE_STEP || code >= 400)) finalCode = code;
        sendNext();
      }
    });

    socket.on('close', () => resolve(finalCode));
  });
}

async function main() {
  const subject = args.subject ?? 'Cogeto test — deadline moved to Friday';
  const body = args.body ?? 'Hi — just confirming the delivery deadline moved to Friday. Thanks!';

  if (args.from) {
    console.log(`\n── Sending one message from ${args.from} → ${TO} ──`);
    const code = await sendOne({ from: args.from, to: TO, subject, body, attach: args.attach });
    report(code, args.from);
    return;
  }

  // Two demo messages: one from a domain you likely allowlisted, one stranger.
  const allowlisted = 'ana@adriatic-foods.hr';
  const stranger = 'stranger@example.net';

  console.log(`\n── (1) allowlisted sender ${allowlisted} → ${TO} ──`);
  console.log('    (accepted only if you added this address/domain in Settings → Email capture)');
  const c1 = await sendOne({ from: allowlisted, to: TO, subject, body, attach: args.attach });
  report(c1, allowlisted);

  console.log(`\n── (2) non-allowlisted sender ${stranger} → ${TO} ──`);
  const c2 = await sendOne({ from: stranger, to: TO, subject, body });
  report(c2, stranger);
}

function report(code, from) {
  if (code === 250) console.log(`✅ ${from}: ACCEPTED (queued for ingestion)\n`);
  else if (code === 550) console.log(`⛔ ${from}: REFUSED (not allowlisted / wrong recipient)\n`);
  else if (code === 552) console.log(`⛔ ${from}: REFUSED (too large)\n`);
  else if (code >= 400 && code < 500)
    console.log(`🕒 ${from}: DEFERRED (${code} — intake temporarily unavailable; retry later)\n`);
  else console.log(`⚠️  ${from}: unexpected final code ${code}\n`);
}

main().catch((error) => {
  console.error(`send-test-email failed: ${error.message}`);
  process.exit(1);
});
