import * as http from 'node:http';
import * as https from 'node:https';

/**
 * Minimal HTTP client for Zitadel's OIDC userinfo endpoint.
 *
 * Uses node:http rather than fetch because Zitadel resolves its instance from
 * the Host header, and the fetch spec forbids overriding Host. Internal calls
 * go to http://zitadel:8080 while presenting the external domain as Host.
 */
export interface UserinfoResponse {
  status: number;
  body: Record<string, unknown>;
}

export function fetchUserinfo(
  internalBaseUrl: string,
  externalDomain: string,
  accessToken: string,
): Promise<UserinfoResponse> {
  const base = new URL(internalBaseUrl);
  const lib = base.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        host: base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        path: '/oidc/v1/userinfo',
        method: 'GET',
        headers: {
          host: externalDomain,
          'x-forwarded-proto': 'https',
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: Record<string, unknown> = {};
          try {
            body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            // non-JSON error body; status is what matters
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('userinfo request timed out')));
    req.on('error', reject);
    req.end();
  });
}
