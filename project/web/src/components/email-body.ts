/**
 * Rendering a retained email body safely (security audit 2.0 SEC-7).
 *
 * The drawer used to write the stored HTML straight into the page with
 * `dangerouslySetInnerHTML`, so the ONLY thing between hostile mail and script
 * execution was the intake sanitizer plus the edge CSP. The intake sanitizer is
 * now parser-based (see `connectors/email-parse.ts`), and this module is the
 * second, independent layer: the body is rendered inside a sandboxed iframe, so
 * a future bypass of the sanitizer has nowhere to execute.
 *
 * What the sandbox gives us that a `<div>` cannot:
 *
 *   - no `allow-scripts`: script simply does not run in the frame, whatever
 *     markup got through;
 *   - no `allow-same-origin`: the frame is an opaque origin, so it cannot read
 *     the session token, cookies or the DOM of the app around it;
 *   - no `allow-forms` and no `allow-top-navigation`: a phishing form cannot
 *     post anywhere and the message cannot navigate the app away.
 *
 * `allow-popups` (with `allow-popups-to-escape-sandbox`) is the one capability
 * kept, so an ordinary link in an email still opens in a new tab as it did
 * before. Links reaching this point have already been reduced to safe schemes.
 */
export const EMAIL_FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/**
 * Neutralize remote content in retained email HTML before rendering: tracking
 * pixels and remote images do not auto-load, which is the choice most mail
 * clients make. Formatting is preserved. This is a PRIVACY measure, not the
 * XSS boundary — the sanitizer and the sandbox are that.
 */
export function neutralizeRemoteHtml(html: string): string {
  return html
    .replace(/\s(src|background)\s*=\s*("|')?\s*https?:[^"'\s>]*/gi, ' data-remote-src="blocked"')
    .replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/url\(\s*['"]?https?:[^)]*\)/gi, 'none');
}

/**
 * The complete document handed to the sandboxed frame's `srcdoc`.
 *
 * It carries its own restrictive CSP as a belt-and-braces measure: the sandbox
 * attribute is what actually blocks execution, and this makes the frame's
 * policy explicit and independent of the edge headers, which is what matters
 * for a document the app itself supplies. `default-src 'none'` also means no
 * remote request of any kind can be issued from the frame, so a payload that
 * slipped past `neutralizeRemoteHtml` still cannot phone home.
 */
export function emailFrameDocument(html: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="',
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;",
    "form-action 'none'; base-uri 'none'; script-src 'none'",
    '">',
    '<base target="_blank">',
    '<style>',
    'html,body{margin:0;padding:0;background:transparent}',
    'body{font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#334155;',
    'padding:12px;word-break:break-word;overflow-wrap:anywhere}',
    'img,table{max-width:100%}',
    'table{border-collapse:collapse}',
    'a{color:#0f766e}',
    '@media (prefers-color-scheme: dark){body{color:#cbd5e1}a{color:#5eead4}}',
    '</style></head><body>',
    neutralizeRemoteHtml(html),
    '</body></html>',
  ].join('');
}
