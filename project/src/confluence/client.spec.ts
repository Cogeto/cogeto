import { describe, expect, it } from 'vitest';
import {
  ConfluenceClient,
  ConfluenceHttpError,
  ConfluenceNotAConfluenceError,
  ConfluenceUnreachableError,
  normalizeSiteUrl,
} from './client';

/**
 * The GET-only client against an injected fake fetch (V2.5 item 8.2, issue
 * A): URL normalization, the Basic credential, response flattening, and the
 * failure taxonomy the connect flow and the sync engine classify.
 */

const AUTH = {
  siteUrl: 'https://acme.atlassian.net',
  email: 'user@example.com',
  apiToken: 'tok-1',
};

const json = (
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

function clientWith(
  respond: (url: string) => Response | Promise<Response>,
  calls: Recorded[] = [],
): ConfluenceClient {
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(String(input));
  }) as typeof fetch;
  return new ConfluenceClient(AUTH, impl);
}

describe('normalizeSiteUrl', () => {
  it('accepts_a_bare_host_and_prefixes_https', () => {
    expect(normalizeSiteUrl('acme.atlassian.net')).toBe('https://acme.atlassian.net');
  });

  it('keeps_an_explicit_https_url_and_trims_whitespace', () => {
    expect(normalizeSiteUrl('  https://acme.atlassian.net  ')).toBe('https://acme.atlassian.net');
  });

  it('strips_a_trailing_wiki_path_with_or_without_the_slash', () => {
    expect(normalizeSiteUrl('https://acme.atlassian.net/wiki')).toBe('https://acme.atlassian.net');
    expect(normalizeSiteUrl('acme.atlassian.net/wiki/')).toBe('https://acme.atlassian.net');
  });

  it('allows_plain_http_for_a_proxied_internal_site', () => {
    expect(normalizeSiteUrl('http://confluence.internal.example')).toBe(
      'http://confluence.internal.example',
    );
  });

  it('refuses_garbage_and_non_http_schemes', () => {
    expect(normalizeSiteUrl('')).toBeNull();
    expect(normalizeSiteUrl('   ')).toBeNull();
    expect(normalizeSiteUrl('not a url')).toBeNull();
    expect(normalizeSiteUrl('localhost')).toBeNull(); // no dot: not a site
    expect(normalizeSiteUrl('ftp://acme.atlassian.net')).toBeNull();
  });
});

describe('requests', () => {
  it('sends_basic_auth_formed_from_email_and_token', async () => {
    const calls: Recorded[] = [];
    const client = clientWith(() => json({ results: [] }), calls);
    await client.listSpaces();
    const headers = calls[0]!.init?.headers as Record<string, string>;
    const expected = Buffer.from('user@example.com:tok-1', 'utf8').toString('base64');
    expect(headers.authorization).toBe(`Basic ${expected}`);
    expect(headers.accept).toBe('application/json');
  });
});

describe('listSpaces', () => {
  it('maps_spaces_with_name_and_type_fallbacks_and_follows_the_cursor', async () => {
    const calls: Recorded[] = [];
    const client = clientWith(
      (url) =>
        url.includes('cursor=abc')
          ? json({ results: [{ id: 12, key: 'HR' }], _links: {} })
          : json({
              results: [{ id: 11, key: 'ENG', name: 'Engineering', type: 'global' }],
              _links: { next: '/wiki/api/v2/spaces?cursor=abc' },
            }),
      calls,
    );

    const first = await client.listSpaces();
    expect(first.spaces).toEqual([{ id: '11', key: 'ENG', name: 'Engineering', type: 'global' }]);
    expect(first.next).toBe('/wiki/api/v2/spaces?cursor=abc');

    const second = await client.listSpaces(first.next);
    expect(calls[1]!.url).toBe(`${AUTH.siteUrl}/wiki/api/v2/spaces?cursor=abc`);
    expect(second.spaces).toEqual([{ id: '12', key: 'HR', name: 'HR', type: 'global' }]);
    expect(second.next).toBeNull();
  });
});

describe('searchContent', () => {
  it('flattens_pages_and_attachments_and_drops_other_content_types', async () => {
    const client = clientWith(() =>
      json({
        results: [
          {
            id: 9,
            type: 'page',
            title: 'Sync Engine',
            version: { number: 4, when: '2026-08-01T00:00:00.000Z' },
            space: { key: 'ENG', name: 'Engineering', type: 'global' },
            ancestors: [
              { id: 1, title: 'Root' },
              { id: 2, title: 'Parent' },
            ],
            _links: { webui: '/spaces/ENG/pages/9' },
          },
          {
            id: 900,
            type: 'attachment',
            title: 'handbook.pdf',
            version: { number: 2, when: '2026-08-02T00:00:00.000Z' },
            container: { id: 9, title: 'Sync Engine' },
            extensions: { mediaType: 'application/pdf', fileSize: 2048 },
            _links: { download: '/download/attachments/9/900', webui: '/pages/9?att=900' },
          },
          { id: 'x', type: 'comment', title: 'noise' },
        ],
        _links: { next: '/rest/api/content/search?cursor=2' },
      }),
    );

    const { items, next } = await client.searchContent('space = "ENG"');
    expect(items).toHaveLength(2);
    const page = items[0]!;
    expect(page).toMatchObject({
      id: '9',
      type: 'page',
      title: 'Sync Engine',
      version: 4,
      modifiedAt: '2026-08-01T00:00:00.000Z',
      spaceKey: 'ENG',
      spaceName: 'Engineering',
      spaceType: 'global',
      parentId: '2',
      parentTitle: 'Parent',
      webuiPath: '/spaces/ENG/pages/9',
    });
    const attachment = items[1]!;
    expect(attachment).toMatchObject({
      id: '900',
      type: 'attachment',
      containerId: '9',
      containerTitle: 'Sync Engine',
      mediaType: 'application/pdf',
      fileSize: 2048,
      downloadPath: '/download/attachments/9/900',
    });
    expect(next).toBe('/rest/api/content/search?cursor=2');
  });
});

describe('failure taxonomy', () => {
  it('a_401_surfaces_as_an_http_error_with_the_status', async () => {
    const client = clientWith(() => json({}, { status: 401 }));
    const error = await client.listSpaces().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfluenceHttpError);
    expect((error as ConfluenceHttpError).status).toBe(401);
  });

  it('a_429_carries_the_retry_after_seconds_and_null_without_the_header', async () => {
    const limited = clientWith(() => json({}, { status: 429, headers: { 'retry-after': '30' } }));
    const withHeader = await limited.listSpaces().catch((e: unknown) => e);
    expect(withHeader).toBeInstanceOf(ConfluenceHttpError);
    expect((withHeader as ConfluenceHttpError).status).toBe(429);
    expect((withHeader as ConfluenceHttpError).retryAfterSeconds).toBe(30);

    const bare = clientWith(() => json({}, { status: 429 }));
    const withoutHeader = await bare.listSpaces().catch((e: unknown) => e);
    expect((withoutHeader as ConfluenceHttpError).retryAfterSeconds).toBeNull();
  });

  it('a_network_failure_surfaces_as_unreachable', async () => {
    const client = clientWith(() => {
      throw new TypeError('fetch failed');
    });
    const error = await client.listSpaces().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfluenceUnreachableError);
  });

  it('an_html_answer_is_not_a_confluence_api', async () => {
    const client = clientWith(
      () =>
        new Response('<html><body>Log in</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const error = await client.listSpaces().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfluenceNotAConfluenceError);
  });
});

describe('getPageBody', () => {
  it('a_404_resolves_to_null_the_gone_upstream_signal', async () => {
    const client = clientWith(() => json({}, { status: 404 }));
    expect(await client.getPageBody('9')).toBeNull();
  });
});

describe('hasReadRestrictions', () => {
  it('reports_true_when_any_user_or_group_is_named', async () => {
    const client = clientWith(() =>
      json({ restrictions: { user: { results: [{}] }, group: { results: [] } } }),
    );
    expect(await client.hasReadRestrictions('9')).toBe(true);
  });

  it('reports_false_when_both_listings_are_empty', async () => {
    const client = clientWith(() =>
      json({ restrictions: { user: { results: [] }, group: { results: [] } } }),
    );
    expect(await client.hasReadRestrictions('9')).toBe(false);
  });

  it('fails_closed_on_a_404_treating_unreadable_restrictions_as_restricted', async () => {
    const client = clientWith(() => json({}, { status: 404 }));
    expect(await client.hasReadRestrictions('9')).toBe(true);
  });
});
