#!/usr/bin/env node
/**
 * Write `project/web/src/locales/en/serverErrors.json` from the server's own
 * throw sites (F13). `npm run i18n:server-errors`.
 *
 * The English sentence a user reads for a server failure lives twice: at the
 * throw site, where it is also the log line and the answer to a client that is
 * not our SPA, and in the interface's `serverErrors` namespace, where it is the
 * source text every translation is made from. This regenerates the second from
 * the first, so the two can never disagree; `npm run i18n:check` fails the
 * build when they do.
 *
 * It only ever rewrites `en`. Translations are backfilled by `npm run
 * i18n:sync` afterwards, exactly like any other namespace, and are never
 * touched here.
 */
import { writeFileSync } from 'node:fs';
import { readServerErrorCodes, SERVER_ERROR_NAMESPACE } from '../ci/server-error-codes.mjs';

const TARGET = `project/web/src/locales/en/${SERVER_ERROR_NAMESPACE}.json`;

const { codes, problems } = readServerErrorCodes();
if (problems.length > 0) {
  console.error('Cannot generate: the server has coded failures it cannot read.\n');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

/** `a.b.c` -> nested, because i18next reads `.` as the key separator. */
function place(tree, path, value) {
  const parts = path.split('.');
  let node = tree;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

const tree = {};
for (const code of [...codes.keys()].sort()) {
  const { forms } = codes.get(code);
  if (forms.one === undefined) {
    place(tree, code, forms.other);
  } else {
    // A count-dependent sentence. `en` carries the two forms English has;
    // `i18n:sync` expands them into the categories each other locale needs.
    place(tree, `${code}_one`, forms.one);
    place(tree, `${code}_other`, forms.other);
  }
}

writeFileSync(TARGET, `${JSON.stringify(tree, null, 2)}\n`);
console.log(`${TARGET}: ${codes.size} codes.`);
