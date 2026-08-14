import { describe, expect, it } from 'vitest';
import { resolveLanguage, tokenize } from './code-highlight';

/**
 * The hand-rolled code highlighter (issue #581).
 *
 * One property matters more than every colour it produces: TOKENISING NEVER
 * CHANGES THE TEXT. Code on screen that is not byte-for-byte the code the
 * model wrote is worse than uncoloured code, because a reader will copy it and
 * run it. Every case here re-asserts the round trip, and the fuzz case asserts
 * it over inputs nobody thought about.
 */

const roundTrip = (code: string, lang: string | null): string =>
  tokenize(code, lang)
    .map((token) => token.text)
    .join('');

const kinds = (code: string, lang: string): string[] => tokenize(code, lang).map((t) => t.kind);

describe('code highlighting never alters the text', () => {
  const samples: Array<[string, string | null]> = [
    ['def f(*args, **kwargs):\n    return 1  # done', 'python'],
    ['const a = `x${y}z`; // note\n/* block\n   comment */', 'typescript'],
    ["SELECT * FROM t WHERE a = 'x' -- trailing", 'sql'],
    ['{"a": [1, 2.5, true, null], "b": "\\"quoted\\""}', 'json'],
    ['echo "hi" | grep -o \'x\' # comment', 'bash'],
    ['key: value\nlist:\n  - a  # note', 'yaml'],
    ['fn main() { println!("hi"); }', 'rust'],
    ['nothing in particular', null],
    ['', 'python'],
    ['"unterminated string', 'python'],
    ['/* unterminated block', 'typescript'],
    ['"""doc\nstring"""\nx = 1', 'python'],
    ['\n\n\t  \n', 'python'],
    ['🙂 emoji and ünïcödé', 'python'],
  ];

  for (const [code, lang] of samples) {
    it(`round-trips ${lang ?? 'plain'}: ${JSON.stringify(code.slice(0, 28))}`, () => {
      expect(roundTrip(code, lang)).toBe(code);
    });
  }

  it('round-trips arbitrary input for every language (fuzz)', () => {
    const alphabet = [...'abc{}()"\'`#/*-\n\t 019_$\\', '```', '"""'];
    const langs = ['python', 'typescript', 'json', 'sql', 'bash', 'yaml', 'nope', null];
    let seed = 20260814;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 400; i += 1) {
      let code = '';
      for (let j = next(40); j > 0; j -= 1) code += alphabet[next(alphabet.length)];
      const lang = langs[next(langs.length)]!;
      expect(roundTrip(code, lang), `lang=${lang} code=${JSON.stringify(code)}`).toBe(code);
    }
  });
});

describe('language resolution', () => {
  it('maps the aliases an answer model actually writes', () => {
    expect(resolveLanguage('py')).toBe('python');
    expect(resolveLanguage('TS')).toBe('typescript');
    expect(resolveLanguage('sh')).toBe('bash');
    expect(resolveLanguage('yml')).toBe('yaml');
    expect(resolveLanguage('psql')).toBe('sql');
  });

  it('an unknown or absent language is null, and tokenises as one plain run', () => {
    expect(resolveLanguage('brainfuck')).toBeNull();
    expect(resolveLanguage(null)).toBeNull();
    expect(kinds('let x = 1', 'brainfuck')).toEqual(['plain']);
  });
});

describe('what it actually colours', () => {
  it('python: keyword, string, comment, number', () => {
    const tokens = tokenize('def f():\n    return "x"  # 12', 'python');
    const byKind = (kind: string): string[] =>
      tokens.filter((t) => t.kind === kind).map((t) => t.text);
    expect(byKind('keyword')).toContain('def');
    expect(byKind('keyword')).toContain('return');
    expect(byKind('string')).toContain('"x"');
    expect(byKind('comment')).toContain('# 12');
  });

  it('a keyword inside a string or a comment is not a keyword', () => {
    const tokens = tokenize('x = "return this"  # def y', 'python');
    expect(tokens.filter((t) => t.kind === 'keyword')).toEqual([]);
  });

  it('sql keywords match case-insensitively', () => {
    expect(tokenize('SELECT a FROM t', 'sql').filter((t) => t.kind === 'keyword')).toHaveLength(2);
  });

  it('an unterminated string stops at the line, so one quote cannot recolour the block', () => {
    const tokens = tokenize('x = "oops\ny = 1', 'python');
    const string = tokens.find((t) => t.kind === 'string');
    expect(string?.text).toBe('"oops');
    expect(tokens.some((t) => t.kind === 'number' && t.text === '1')).toBe(true);
  });
});
