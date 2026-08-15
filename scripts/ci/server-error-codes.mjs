/**
 * Read the server's user-facing failures out of the source (F13, F14).
 *
 * Every HTTP failure the server raises is built by `infrastructure/api-error.ts`
 * through one of two factories, and the throw site says which:
 *
 *   userError.notFound('memory.notFound', 'memory {{id}} not found', { id })
 *   untranslatedError.badRequest(`unknown action type '${actionType}'`)
 *
 * `userError` carries a CODE the interface translates. This module extracts
 * every `(code, English template)` pair so `check-i18n.mjs` can hold the
 * `serverErrors` namespace to it: no code without a key, no key without a code,
 * and no English that has drifted from the sentence at the throw site.
 *
 * It is a small parser rather than a regex because the templates wrap across
 * lines, concatenate with `+`, and switch quote style when they contain an
 * apostrophe. It is not a TypeScript parser, and it does not need to be: it
 * only ever reads two string literals after a known call head, and it FAILS
 * (rather than skipping) on anything it cannot read, so a call it does not
 * understand is a build error instead of a silent gap.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const SERVER_ROOT = 'project/src';
/** The one file allowed to construct a Nest exception directly. */
export const API_ERROR_FILE = 'project/src/infrastructure/api-error.ts';
/** The interface namespace holding one key per code. */
export const SERVER_ERROR_NAMESPACE = 'serverErrors';

const KINDS = [
  'badRequest',
  'unauthorized',
  'forbidden',
  'notFound',
  'conflict',
  'gone',
  'tooLarge',
  'unprocessable',
  'unavailable',
  'tooManyRequests',
];

export const NEST_EXCEPTION_RE =
  /new (BadRequest|NotFound|Forbidden|Conflict|Unauthorized|UnprocessableEntity|PayloadTooLarge|ServiceUnavailable|Gone|InternalServerError|HttpException)Exception\(/;

export function serverSourceFiles(root = SERVER_ROOT, out = []) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === 'locales') continue;
    if (statSync(path).isDirectory()) serverSourceFiles(path, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

// ── The tiny reader ──────────────────────────────────────────────────────────

class Reader {
  constructor(text, at) {
    this.text = text;
    this.at = at;
  }
  skipTrivia() {
    while (this.at < this.text.length) {
      const ch = this.text[this.at];
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') this.at++;
      else if (this.text.startsWith('//', this.at)) {
        const end = this.text.indexOf('\n', this.at);
        this.at = end === -1 ? this.text.length : end;
      } else break;
    }
  }
  /** One `'…'` or `"…"` literal, plus any `+ '…'` continuations. Null if none. */
  literal() {
    this.skipTrivia();
    let value = null;
    for (;;) {
      const quote = this.text[this.at];
      if (quote !== "'" && quote !== '"') return value;
      let out = '';
      this.at++;
      while (this.at < this.text.length && this.text[this.at] !== quote) {
        if (this.text[this.at] === '\\') {
          const next = this.text[this.at + 1];
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          this.at += 2;
        } else {
          out += this.text[this.at];
          this.at++;
        }
      }
      this.at++;
      value = (value ?? '') + out;
      // A concatenation continues the same sentence.
      const save = this.at;
      this.skipTriviaNoComma();
      if (this.text[this.at] === '+') {
        this.at++;
        this.skipTriviaNoComma();
        continue;
      }
      this.at = save;
      return value;
    }
  }
  skipTriviaNoComma() {
    while (this.at < this.text.length && /[\s]/.test(this.text[this.at])) this.at++;
  }
}

/**
 * Every coded failure in one file.
 *
 * @returns {{ codes: Array<{code, forms, file, line}>, problems: string[] }}
 *   `forms` is `{ other }` for an ordinary message and `{ one, other }` for one
 *   whose grammar depends on a count.
 */
export function codesInFile(file, text) {
  const codes = [];
  const problems = [];
  const lineOf = (index) => text.slice(0, index).split('\n').length;

  const head = new RegExp(`\\buserError\\.(${KINDS.join('|')})\\(`, 'g');
  for (const match of text.matchAll(head)) {
    const reader = new Reader(text, match.index + match[0].length);
    const where = `${file}:${lineOf(match.index)}`;
    const code = reader.literal();
    if (code === null) {
      problems.push(`${where}: userError needs a string-literal code as its first argument.`);
      continue;
    }
    reader.skipTrivia();
    let forms;
    if (text[reader.at] === '{') {
      // A plural template: { one: '…', other: '…' }. Brace-matched while
      // skipping string bodies, because `{{count}}` lives inside one.
      let depth = 0;
      let cursor = reader.at;
      for (; cursor < text.length; cursor++) {
        const ch = text[cursor];
        if (ch === "'" || ch === '"') {
          cursor++;
          while (cursor < text.length && text[cursor] !== ch) {
            cursor += text[cursor] === '\\' ? 2 : 1;
          }
          continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) break;
      }
      const block = text.slice(reader.at, cursor + 1);
      const one = new Reader(block, block.indexOf('one:') + 4).literal();
      const other = new Reader(block, block.indexOf('other:') + 6).literal();
      if (one === null || other === null) {
        problems.push(`${where}: a plural template needs literal "one" and "other" forms.`);
        continue;
      }
      forms = { one, other };
    } else {
      const template = reader.literal();
      if (template === null) {
        problems.push(
          `${where}: userError needs a string-literal English template as its second ` +
            'argument. A value inside the sentence is {{named}} interpolation, never a ' +
            'template literal: word order differs by language.',
        );
        continue;
      }
      forms = { other: template };
    }
    for (const value of Object.values(forms)) {
      if (value.includes('${')) {
        problems.push(
          `${where}: the template for "${code}" builds a value into the string. ` +
            'Use {{named}} interpolation and pass the value in `params`.',
        );
      }
    }
    codes.push({ code, forms, file, line: lineOf(match.index) });
  }
  return { codes, problems };
}

/** Every coded failure the server can raise, plus everything wrong with them. */
export function readServerErrorCodes() {
  const codes = new Map();
  const problems = [];
  for (const file of serverSourceFiles()) {
    const text = readFileSync(file, 'utf8');
    const found = codesInFile(file, text);
    problems.push(...found.problems);
    for (const entry of found.codes) {
      const existing = codes.get(entry.code);
      if (!existing) {
        codes.set(entry.code, entry);
        continue;
      }
      const same = JSON.stringify(existing.forms) === JSON.stringify(entry.forms);
      if (!same) {
        problems.push(
          `${entry.file}:${entry.line}: code "${entry.code}" is raised with different English ` +
            `than ${existing.file}:${existing.line}. One code is one sentence.\n` +
            `      there: ${JSON.stringify(existing.forms)}\n` +
            `      here:  ${JSON.stringify(entry.forms)}`,
        );
      }
    }
  }
  return { codes, problems };
}
