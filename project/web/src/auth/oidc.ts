import type { WebConfig } from '@cogeto/shared';
import { codeChallengeS256, randomToken } from './pkce';

/**
 * OIDC authorization-code + PKCE flow against Zitadel through Caddy
 * (same origin, no CORS). The approval decision is always server-side (§A.8);
 * this session only authenticates the dashboard shell.
 */

const VERIFIER_KEY = 'cogeto.pkce_verifier';
const STATE_KEY = 'cogeto.oauth_state';
const SESSION_KEY = 'cogeto.session';

const SCOPES = 'openid profile email urn:zitadel:iam:user:resourceowner';

export interface Session {
  accessToken: string;
  idToken: string;
  expiresAt: number;
}

interface DiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return (await response.json()) as T;
}

export function getWebConfig(): Promise<WebConfig> {
  return fetchJson<WebConfig>('/api/config');
}

function discover(issuer: string): Promise<DiscoveryDocument> {
  return fetchJson<DiscoveryDocument>(
    `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
  );
}

export function redirectUri(): string {
  return `${window.location.origin}/callback`;
}

export async function startLogin(): Promise<void> {
  const config = await getWebConfig();
  const discovery = await discover(config.issuer);

  const verifier = randomToken();
  const state = randomToken(16);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await codeChallengeS256(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  window.location.assign(url.toString());
}

export async function completeLogin(callbackUrl: string): Promise<Session> {
  const params = new URL(callbackUrl).searchParams;
  const code = params.get('code');
  const state = params.get('state');
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const expectedState = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);

  if (params.get('error'))
    throw new Error(`login failed: ${params.get('error_description') ?? params.get('error')}`);
  if (!code || !verifier) throw new Error('login callback is missing the code or verifier');
  if (!state || state !== expectedState) throw new Error('login callback state mismatch');

  const config = await getWebConfig();
  const discovery = await discover(config.issuer);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: config.clientId,
    code_verifier: verifier,
  });
  const tokens = await fetchJson<{ access_token: string; id_token: string; expires_in: number }>(
    discovery.token_endpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
  );

  const session: Session = {
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

const DEMO_FLAG_KEY = 'cogeto.demo';

/**
 * Ana sandbox (decision 0022): install the pre-minted demo session served on
 * /api/config, so a visitor is authenticated on first load with no login. The
 * token is a real Zitadel PAT; only the local expiry is synthetic (far out).
 */
export function installDemoSession(accessToken: string): Session {
  const session: Session = {
    accessToken,
    idToken: '',
    expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  sessionStorage.setItem(DEMO_FLAG_KEY, '1');
  return session;
}

/** True in the current tab once a demo session has been installed. */
export function isDemoSession(): boolean {
  return sessionStorage.getItem(DEMO_FLAG_KEY) === '1';
}

export function loadSession(): Session | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as Session;
    if (session.expiresAt <= Date.now()) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export async function logout(): Promise<void> {
  const session = loadSession();
  sessionStorage.removeItem(SESSION_KEY);
  try {
    const config = await getWebConfig();
    const discovery = await discover(config.issuer);
    if (discovery.end_session_endpoint && session) {
      const url = new URL(discovery.end_session_endpoint);
      url.searchParams.set('id_token_hint', session.idToken);
      url.searchParams.set('post_logout_redirect_uri', `${window.location.origin}/`);
      window.location.assign(url.toString());
      return;
    }
  } catch {
    // fall through to a local logout
  }
  window.location.assign('/');
}
