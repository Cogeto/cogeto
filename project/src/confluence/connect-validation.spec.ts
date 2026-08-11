import { describe, expect, it } from 'vitest';
import { ConfluenceClient } from './client';
import { validateConnection } from './confluence.controller';

/**
 * The connect-time validation taxonomy (V2.5 item 8.2, issue A1): one read
 * call with the material still in hand, and a specific answer for what
 * failed. Each upstream shape maps to exactly one reported reason.
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

function clientAnswering(respond: () => Response | Promise<Response>): ConfluenceClient {
  const impl = (async () => respond()) as typeof fetch;
  return new ConfluenceClient(AUTH, impl);
}

describe('validateConnection', () => {
  it('a_space_listing_validates_and_reports_how_many_spaces_are_visible', async () => {
    const client = clientAnswering(() =>
      json({
        results: [
          { id: 1, key: 'ENG', name: 'Engineering' },
          { id: 2, key: 'HR', name: 'People Ops' },
        ],
      }),
    );
    expect(await validateConnection(client)).toEqual({ ok: true, spaces: 2 });
  });

  it('an_empty_space_listing_is_no_permission_the_account_can_see_nothing', async () => {
    const client = clientAnswering(() => json({ results: [] }));
    expect(await validateConnection(client)).toEqual({ ok: false, reason: 'no_permission' });
  });

  it('a_401_is_bad_credentials', async () => {
    const client = clientAnswering(() => json({}, { status: 401 }));
    expect(await validateConnection(client)).toEqual({ ok: false, reason: 'bad_credentials' });
  });

  it('a_403_is_no_permission', async () => {
    const client = clientAnswering(() => json({}, { status: 403 }));
    expect(await validateConnection(client)).toEqual({ ok: false, reason: 'no_permission' });
  });

  it('a_network_failure_is_unreachable', async () => {
    const client = clientAnswering(() => {
      throw new TypeError('getaddrinfo ENOTFOUND');
    });
    expect(await validateConnection(client)).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('an_html_answer_is_wrong_site', async () => {
    const client = clientAnswering(
      () =>
        new Response('<html>login</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    expect(await validateConnection(client)).toEqual({ ok: false, reason: 'wrong_site' });
  });

  it('a_404_on_the_api_root_is_wrong_site', async () => {
    const client = clientAnswering(() => json({}, { status: 404 }));
    expect(await validateConnection(client)).toEqual({ ok: false, reason: 'wrong_site' });
  });

  it('a_500_is_unreachable_the_site_is_not_answering_as_itself', async () => {
    const client = clientAnswering(() => json({}, { status: 500 }));
    expect(await validateConnection(client)).toEqual({ ok: false, reason: 'unreachable' });
  });
});
