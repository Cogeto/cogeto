/**
 * Syntax highlighting for chat code blocks (issue #581), hand-rolled and
 * dependency-free.
 *
 * WHY NOT A LIBRARY. Shiki carries WASM and per-language grammars; highlight.js
 * is around a megabyte with its full language set. The web bundle already trips
 * Vite's 500 kB warning, and a chat answer's code block is a handful of lines,
 * not an IDE. This file is the same trade the rest of the repository makes (the
 * PDF writer, the ZIP walk, the markdown-lite beside it): a small honest subset,
 * swappable for a real highlighter the day one is worth its weight.
 *
 * THE INVARIANT, and the reason this is testable: highlighting NEVER changes
 * the text. `tokenize(code, lang).map(t => t.text).join('') === code` for every
 * input and every language, including unknown ones. A highlighter that can drop
 * or reorder a character is worse than no highlighter at all, because the code
 * on screen would no longer be the code the model wrote.
 *
 * An unknown or absent language yields one plain token, so the block still gets
 * its chrome, its copy button and its monospace, and simply is not coloured.
 */

/** What a token means. The renderer maps these onto theme classes. */
export type TokenKind = 'plain' | 'comment' | 'string' | 'keyword' | 'number' | 'punct';

export interface CodeToken {
  kind: TokenKind;
  text: string;
}

/** One language's lexical shape. Order matters: first match at a position wins. */
interface LanguageSpec {
  /** Line comments, e.g. `//` or `#`. */
  lineComment?: readonly string[];
  /** Block comment delimiters, e.g. `/*` … */
  blockComment?: readonly [string, string];
  /** Quote characters that open a string. */
  quotes?: readonly string[];
  /** Triple-quoted strings (Python docstrings). */
  tripleQuotes?: readonly string[];
  /** Whether a backslash escapes the next character inside a string. */
  escapes?: boolean;
  keywords: readonly string[];
}

const C_LIKE_PUNCT = '{}()[];,.:<>=+-*/%!&|^~?';

const JS_KEYWORDS = [
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'of',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'try',
  'type',
  'typeof',
  'var',
  'void',
  'while',
  'yield',
  'true',
  'false',
  'null',
  'undefined',
] as const;

const PY_KEYWORDS = [
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'False',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'None',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'True',
  'try',
  'while',
  'with',
  'yield',
] as const;

const SQL_KEYWORDS = [
  'alter',
  'and',
  'as',
  'asc',
  'begin',
  'between',
  'by',
  'case',
  'commit',
  'create',
  'delete',
  'desc',
  'distinct',
  'drop',
  'else',
  'end',
  'exists',
  'from',
  'group',
  'having',
  'in',
  'index',
  'inner',
  'insert',
  'into',
  'is',
  'join',
  'left',
  'limit',
  'not',
  'null',
  'offset',
  'on',
  'or',
  'order',
  'outer',
  'primary',
  'references',
  'right',
  'rollback',
  'select',
  'set',
  'table',
  'then',
  'union',
  'update',
  'values',
  'when',
  'where',
  'with',
] as const;

const SHELL_KEYWORDS = [
  'case',
  'cd',
  'do',
  'done',
  'echo',
  'elif',
  'else',
  'esac',
  'exit',
  'export',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'local',
  'return',
  'set',
  'then',
  'until',
  'while',
] as const;

const LANGUAGES: Record<string, LanguageSpec> = {
  javascript: {
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'", '`'],
    escapes: true,
    keywords: JS_KEYWORDS,
  },
  typescript: {
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'", '`'],
    escapes: true,
    keywords: JS_KEYWORDS,
  },
  json: { quotes: ['"'], escapes: true, keywords: ['true', 'false', 'null'] },
  python: {
    lineComment: ['#'],
    quotes: ['"', "'"],
    tripleQuotes: ['"""', "'''"],
    escapes: true,
    keywords: PY_KEYWORDS,
  },
  sql: {
    lineComment: ['--'],
    blockComment: ['/*', '*/'],
    quotes: ["'", '"'],
    keywords: SQL_KEYWORDS,
  },
  bash: { lineComment: ['#'], quotes: ['"', "'"], escapes: true, keywords: SHELL_KEYWORDS },
  yaml: {
    lineComment: ['#'],
    quotes: ['"', "'"],
    escapes: true,
    keywords: ['true', 'false', 'null', 'yes', 'no'],
  },
};

/** Aliases an answer model actually writes on a fence. */
const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  py3: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  postgres: 'sql',
  postgresql: 'sql',
  psql: 'sql',
  yml: 'yaml',
  jsonc: 'json',
};

/** The canonical language for a fence's info string, or null when unknown. */
export function resolveLanguage(lang: string | null): string | null {
  if (!lang) return null;
  const key = lang.toLowerCase();
  const canonical = ALIASES[key] ?? key;
  return canonical in LANGUAGES ? canonical : null;
}

const isIdentStart = (ch: string): boolean => /[A-Za-z_$]/.test(ch);
const isIdent = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch);
const isDigit = (ch: string): boolean => /[0-9]/.test(ch);

/**
 * Split code into typed tokens. Never throws, never alters the text: an
 * unrecognised character is emitted as `plain`, so the join of every token is
 * always the input exactly.
 */
export function tokenize(code: string, lang: string | null): CodeToken[] {
  const spec = LANGUAGES[resolveLanguage(lang) ?? ''];
  if (!spec || code.length === 0) return code ? [{ kind: 'plain', text: code }] : [];

  const tokens: CodeToken[] = [];
  const keywords = new Set(spec.keywords);
  let plain = '';
  const flush = () => {
    if (plain) tokens.push({ kind: 'plain', text: plain });
    plain = '';
  };
  const push = (kind: TokenKind, text: string) => {
    flush();
    tokens.push({ kind, text });
  };

  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);

    // Block comment — runs across lines; unterminated runs to the end.
    if (spec.blockComment && rest.startsWith(spec.blockComment[0])) {
      const close = code.indexOf(spec.blockComment[1], i + spec.blockComment[0].length);
      const end = close === -1 ? code.length : close + spec.blockComment[1].length;
      push('comment', code.slice(i, end));
      i = end;
      continue;
    }

    // Line comment — to the newline, which stays outside the token.
    const line = spec.lineComment?.find((marker) => rest.startsWith(marker));
    if (line) {
      const newline = code.indexOf('\n', i);
      const end = newline === -1 ? code.length : newline;
      push('comment', code.slice(i, end));
      i = end;
      continue;
    }

    // Triple-quoted string before the single-quote case, or `"""` reads as an
    // empty string followed by a quote.
    const triple = spec.tripleQuotes?.find((quote) => rest.startsWith(quote));
    if (triple) {
      const close = code.indexOf(triple, i + triple.length);
      const end = close === -1 ? code.length : close + triple.length;
      push('string', code.slice(i, end));
      i = end;
      continue;
    }

    const quote = spec.quotes?.find((q) => rest.startsWith(q));
    if (quote) {
      let j = i + quote.length;
      while (j < code.length) {
        if (spec.escapes && code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code.startsWith(quote, j)) {
          j += quote.length;
          break;
        }
        // An unterminated string ends at the line break rather than swallowing
        // the rest of the block: a stray quote must not recolour everything.
        // Unconditional, because a MULTI-line string is the triple-quote
        // branch above; reaching here means a single quote opened it, and
        // those do not span lines in any language handled here.
        if (code[j] === '\n') break;
        j += 1;
      }
      push('string', code.slice(i, Math.min(j, code.length)));
      i = Math.min(j, code.length);
      continue;
    }

    const ch = code[i]!;

    if (isDigit(ch) && !isIdent(code[i - 1] ?? ' ')) {
      let j = i;
      while (j < code.length && /[0-9a-fA-FxX._]/.test(code[j]!)) j += 1;
      push('number', code.slice(i, j));
      i = j;
      continue;
    }

    if (isIdentStart(ch)) {
      let j = i;
      while (j < code.length && isIdent(code[j]!)) j += 1;
      const word = code.slice(i, j);
      const known = keywords.has(word) || keywords.has(word.toLowerCase());
      if (known) push('keyword', word);
      else plain += word;
      i = j;
      continue;
    }

    if (C_LIKE_PUNCT.includes(ch)) {
      push('punct', ch);
      i += 1;
      continue;
    }

    plain += ch;
    i += 1;
  }
  flush();
  return tokens;
}
