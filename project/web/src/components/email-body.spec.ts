// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EMAIL_FRAME_SANDBOX, emailFrameDocument, neutralizeRemoteHtml } from './email-body';

/**
 * Sandboxed email rendering (security audit 2.0 SEC-7).
 *
 * The drawer used to write retained email HTML into the page with
 * `dangerouslySetInnerHTML`, so the intake sanitizer plus one edge header were
 * the only things between hostile mail and script execution in the owner's
 * session. This is the second, independent layer: even a payload that defeats
 * the sanitizer lands in a frame that cannot run it.
 *
 * The assertions are about the CAPABILITIES the frame is granted, because that
 * is what actually decides whether a bypass matters.
 */
describe('email body rendering', () => {
  it('the frame grants no script execution and no same-origin access', () => {
    const granted = EMAIL_FRAME_SANDBOX.split(/\s+/).filter(Boolean);
    // The two that would make a sanitizer bypass exploitable.
    expect(granted).not.toContain('allow-scripts');
    expect(granted).not.toContain('allow-same-origin');
    // Phishing forms cannot post, and the message cannot navigate the app away.
    expect(granted).not.toContain('allow-forms');
    expect(granted).not.toContain('allow-top-navigation');
    expect(granted).not.toContain('allow-top-navigation-by-user-activation');
    expect(granted).not.toContain('allow-modals');
    // The one capability kept, so an ordinary link still opens in a new tab.
    expect(granted).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox']);
  });

  it('the frame document carries its own restrictive policy', () => {
    const doc = emailFrameDocument('<p>hello</p>');
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain("form-action 'none'");
    expect(doc).toContain("base-uri 'none'");
    // Remote loads of every kind are refused, so a payload that slipped past
    // the remote-content neutralizer still cannot phone home.
    expect(doc).not.toContain('img-src https:');
    expect(doc).toContain('img-src data:');
    expect(doc).toContain('<p>hello</p>');
  });

  it('remote content is neutralized so nothing auto-loads (tracking pixels)', () => {
    const html =
      '<img src="https://tracker.example/pixel.gif" width="1">' +
      '<img srcset="https://tracker.example/a.png 1x">' +
      '<div style="background:url(https://tracker.example/bg.png)">x</div>';
    const out = neutralizeRemoteHtml(html);
    expect(out).not.toContain('https://tracker.example');
    expect(out).toContain('data-remote-src="blocked"');
    // Inline (cid:) images and ordinary formatting are untouched.
    expect(neutralizeRemoteHtml('<img src="cid:logo-1" alt="a">')).toContain('cid:logo-1');
  });

  it('a hostile body is inert inside the frame document', () => {
    // Belt and braces: the sanitizer already removed these server-side, but
    // this layer must hold on its own, so the frame is fed the raw payload.
    const doc = emailFrameDocument('<script>alert(1)</script><img src=x onerror=alert(1)>');
    // The document is a STRING handed to srcdoc; what matters is that the
    // policy accompanying it forbids execution.
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain("default-src 'none'");
    expect(EMAIL_FRAME_SANDBOX).not.toContain('allow-scripts');
  });
});
