import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveLanguage, tokenize } from './code-highlight';
import type { TokenKind } from './code-highlight';

/**
 * A fenced code block in a chat answer (issue #581).
 *
 * Code is the one part of an answer that must be reproduced EXACTLY, so this
 * component is deliberately the opposite of the citation chips beside it: the
 * text is selectable, the copy button yields the raw source with no markers or
 * re-wrapping, and long lines scroll rather than wrap (a wrapped shell command
 * is a broken shell command).
 *
 * Highlighting is best-effort and never authoritative: an unknown language
 * still gets the chrome, the label and the copy button, and simply is not
 * coloured. See code-highlight.ts for why there is no highlighting dependency.
 */

/** Token → theme class. Uses the palette already in the app, not new colours. */
const TOKEN_CLASSES: Record<TokenKind, string> = {
  plain: '',
  comment: 'text-slate-400 italic',
  string: 'text-emerald-700 dark:text-emerald-300',
  keyword: 'text-violet-700 dark:text-violet-300',
  number: 'text-amber-700 dark:text-amber-300',
  punct: 'text-slate-500 dark:text-slate-400',
};

export function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  const resolved = resolveLanguage(lang);
  const tokens = tokenize(code, lang);

  const copy = () => {
    // The RAW source: what the model wrote, byte for byte.
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setCopied(false));
  };

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/60">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-1 dark:border-slate-700">
        <span className="select-none font-mono text-[0.62rem] uppercase tracking-[0.12em] text-slate-400">
          {/* The fence's own label when we do not know it, so a block tagged
              `rust` still says rust rather than claiming to be plain text. */}
          {lang || t('code.plain')}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={t('code.copyAria')}
          className="select-none rounded px-1.5 py-0.5 font-mono text-[0.62rem] uppercase tracking-[0.1em] text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-200"
        >
          {copied ? t('code.copied') : t('code.copy')}
        </button>
      </div>
      {/* Scroll, never wrap: a wrapped command line is a wrong command line. */}
      <pre className="overflow-x-auto px-3 py-2 text-[0.85rem] leading-[1.55]">
        <code className={`font-mono${resolved ? ` language-${resolved}` : ''}`}>
          {tokens.map((token, i) =>
            token.kind === 'plain' ? (
              token.text
            ) : (
              <span key={i} className={TOKEN_CLASSES[token.kind]}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  );
}
