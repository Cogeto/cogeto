import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DEFAULT_PARSE_CAPS, PARSE_CAPS } from '../infrastructure/index';
import type { ParseCaps } from '../infrastructure/index';
import { extractDocumentText } from './document-extract';
import { extractReadableHtml } from './html-text';
import { RESEARCH_OPTIONS } from './research-options';
import type { ResearchOptions } from './research-options';

/**
 * The narrow, server-side fetcher (decision 0042): given URLs the user
 * selected from discovery, it retrieves each page from THIS instance and
 * reduces it to clean text. Narrow by construction:
 *
 * - http(s) only, and never to a private, loopback, or link-local address —
 *   every hop (including each redirect target) is DNS-resolved and checked
 *   before it is fetched (SSRF guard, the upload-hardening posture applied to
 *   the first outbound URL path in the codebase).
 * - robots.txt honoured per origin; a disallowed path is skipped, not fetched.
 * - Hard per-page timeout, response-size cap, and content-type restriction
 *   (HTML + PDF; anything else is skipped and annotated, never guessed at).
 * - Fetch-and-parse, NEVER render: no script execution, no resource loading
 *   (see html-text.ts) — an untrusted page can only contribute text.
 */

/** The identifying agent: honest about who is fetching and why. */
export const RESEARCH_USER_AGENT = 'Mozilla/5.0 (compatible; CogetoResearch/1.0)';
/** The robots.txt product token matched against User-agent groups. */
const ROBOTS_TOKEN = 'cogetoresearch';
const MAX_REDIRECTS = 5;
const ROBOTS_MAX_BYTES = 128 * 1024;

export interface FetchedPage {
  requestedUrl: string;
  /** The URL the content actually came from, after redirects. */
  finalUrl: string;
  title: string | null;
  /** Readable extracted text — the retained source of record. */
  text: string;
  contentType: 'text/html' | 'application/pdf';
  fetchedAt: Date;
  /** The raw HTML body (HTML pages only) for optional retention. */
  rawHtml: string | null;
}

export type FetchSkipReason =
  | 'refused_address'
  | 'blocked_by_robots'
  | 'unsupported_type'
  | 'too_large'
  | 'unreachable'
  | 'http_error'
  | 'empty';

export type FetchOutcome =
  | { status: 'fetched'; page: FetchedPage }
  | { status: 'skipped'; url: string; reason: FetchSkipReason; detail: string };

/** Address-family resolver seam — injectable for fetcher_hardening tests. */
export type ResolveAddresses = (hostname: string) => Promise<string[]>;

const defaultResolve: ResolveAddresses = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
};

/**
 * True for every address a server-side fetcher must refuse (§SSRF): loopback,
 * RFC1918 private, link-local, CGNAT, unspecified, multicast/reserved v4, and
 * their IPv6 equivalents (including v4-mapped forms).
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family === 6) return isPrivateV6(address);
  return true; // not an IP at all — refuse
}

function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 — "this network"
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 192 && b === 0) || // 192.0.0.0/24 + 192.0.2.0/24 doc
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    a >= 224 // multicast + reserved + broadcast
  );
}

function isPrivateV6(address: string): boolean {
  const lower = address.toLowerCase();
  // v4-mapped/compat (::ffff:a.b.c.d) — judge the embedded v4.
  const mapped = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]!);
  if (lower === '::' || lower === '::1') return true; // unspecified + loopback
  return (
    lower.startsWith('fe8') || // fe80::/10 link-local (fe80–febf)
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('fc') || // fc00::/7 unique-local
    lower.startsWith('fd') ||
    lower.startsWith('ff') // multicast
  );
}

/** Minimal robots.txt evaluation: the most specific matching rule wins. */
export function robotsAllows(robotsTxt: string, path: string): boolean {
  interface Group {
    agents: string[];
    rules: { allow: boolean; prefix: string }[];
  }
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (current) current.rules.push({ allow: field === 'allow', prefix: value });
    } else {
      lastWasAgent = false;
    }
  }
  // Our token's groups when any name us; else the wildcard groups.
  const named = groups.filter((g) => g.agents.some((a) => a.includes(ROBOTS_TOKEN)));
  const applicable = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  let winner: { allow: boolean; prefix: string } | null = null;
  for (const group of applicable) {
    for (const rule of group.rules) {
      if (rule.prefix === '') continue; // "Disallow:" (empty) = allow all
      if (!path.startsWith(rule.prefix)) continue;
      if (!winner || rule.prefix.length > winner.prefix.length) winner = rule;
    }
  }
  return winner ? winner.allow : true;
}

@Injectable()
export class WebFetchService {
  private readonly log = new Logger(WebFetchService.name);
  /** Injection seams for fetcher_hardening tests. */
  fetchImpl: typeof fetch = (...args) => fetch(...args);
  resolveAddresses: ResolveAddresses = defaultResolve;
  /** Per-run robots cache: origin → robots.txt body (null = none/unreadable). */
  private readonly robotsCache = new Map<string, string | null>();

  constructor(
    @Inject(RESEARCH_OPTIONS) private readonly options: ResearchOptions,
    @Optional() @Inject(PARSE_CAPS) private readonly parseCaps: ParseCaps = DEFAULT_PARSE_CAPS,
  ) {}

  async fetchPage(requestedUrl: string): Promise<FetchOutcome> {
    const skip = (reason: FetchSkipReason, detail: string): FetchOutcome => ({
      status: 'skipped',
      url: requestedUrl,
      reason,
      detail,
    });

    let url: URL;
    try {
      url = new URL(requestedUrl);
    } catch {
      return skip('refused_address', 'not a valid URL');
    }
    const refusal = await this.refusalFor(url);
    if (refusal) return skip('refused_address', refusal);

    // robots.txt before the page itself — a disallowed path is never fetched.
    const robots = await this.robotsFor(url.origin);
    if (robots !== null && !robotsAllows(robots, url.pathname + url.search)) {
      return skip('blocked_by_robots', `robots.txt disallows ${url.pathname}`);
    }

    const deadline = AbortSignal.timeout(this.options.fetchTimeoutMs);
    let response: Response;
    try {
      response = await this.followRedirects(url, deadline);
    } catch (error) {
      if (error instanceof RefusedAddressError) return skip('refused_address', error.message);
      return skip('unreachable', 'could not fetch the page (network error or timeout)');
    }
    if (!response.ok) {
      return skip('http_error', `the server answered ${response.status}`);
    }
    const finalUrl = response.url || url.toString();
    const contentType = (response.headers.get('content-type') ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    const isHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml';
    const isPdf = contentType === 'application/pdf';
    if (!isHtml && !isPdf) {
      return skip('unsupported_type', `unsupported content type '${contentType || 'unknown'}'`);
    }

    let body: Buffer;
    try {
      body = await readCapped(response, this.options.fetchMaxBytes);
    } catch (error) {
      if (error instanceof TooLargeError) {
        return skip('too_large', `page exceeds the ${this.options.fetchMaxBytes}-byte cap`);
      }
      return skip('unreachable', 'the response body could not be read');
    }

    const fetchedAt = new Date();
    if (isPdf) {
      let text: string;
      try {
        text = await extractDocumentText(body, 'application/pdf', {
          maxTextChars: this.parseCaps.maxTextChars,
          timeoutSeconds: this.parseCaps.timeoutSeconds,
        });
      } catch {
        return skip('empty', 'the PDF could not be parsed');
      }
      if (!text.trim()) return skip('empty', 'the PDF contained no extractable text');
      return {
        status: 'fetched',
        page: {
          requestedUrl,
          finalUrl,
          title: pdfTitleFromUrl(finalUrl),
          text,
          contentType: 'application/pdf',
          fetchedAt,
          rawHtml: null,
        },
      };
    }

    const rawHtml = body.toString('utf8');
    const readable = extractReadableHtml(rawHtml);
    const text =
      readable.text.length > this.parseCaps.maxTextChars
        ? readable.text.slice(0, this.parseCaps.maxTextChars)
        : readable.text;
    if (!text.trim()) return skip('empty', 'no readable content found on the page');
    return {
      status: 'fetched',
      page: {
        requestedUrl,
        finalUrl,
        title: readable.title,
        text,
        contentType: 'text/html',
        fetchedAt,
        rawHtml,
      },
    };
  }

  /** Manual redirect loop: every hop is re-validated before it is fetched. */
  private async followRedirects(start: URL, signal: AbortSignal): Promise<Response> {
    let current = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.fetchImpl(current, {
        redirect: 'manual',
        signal,
        headers: { 'user-agent': RESEARCH_USER_AGENT, accept: 'text/html, application/pdf' },
      });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      await response.body?.cancel().catch(() => undefined);
      const next = new URL(location, current);
      const refusal = await this.refusalFor(next);
      if (refusal) throw new RefusedAddressError(`redirect to a refused address: ${refusal}`);
      current = next;
    }
    throw new Error(`more than ${MAX_REDIRECTS} redirects`);
  }

  /** The SSRF gate: non-null = the human-readable refusal reason. */
  private async refusalFor(url: URL): Promise<string | null> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return `scheme '${url.protocol}' is not allowed (http/https only)`;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (hostname.toLowerCase() === 'localhost' || hostname.toLowerCase().endsWith('.localhost')) {
      return 'localhost is not fetchable';
    }
    if (isIP(hostname) !== 0) {
      return isPrivateAddress(hostname)
        ? `address ${hostname} is private/loopback/link-local`
        : null;
    }
    let addresses: string[];
    try {
      addresses = await this.resolveAddresses(hostname);
    } catch {
      return `could not resolve ${hostname}`;
    }
    if (addresses.length === 0) return `could not resolve ${hostname}`;
    const offender = addresses.find((a) => isPrivateAddress(a));
    return offender ? `${hostname} resolves to a private address` : null;
  }

  /** robots.txt per origin, cached for this service instance's lifetime. */
  private async robotsFor(origin: string): Promise<string | null> {
    if (this.robotsCache.has(origin)) return this.robotsCache.get(origin)!;
    let body: string | null = null;
    try {
      const response = await this.fetchImpl(`${origin}/robots.txt`, {
        signal: AbortSignal.timeout(this.options.fetchTimeoutMs),
        headers: { 'user-agent': RESEARCH_USER_AGENT },
      });
      if (response.ok) {
        const buffer = await readCapped(response, ROBOTS_MAX_BYTES);
        body = buffer.toString('utf8');
      }
      // 4xx/5xx → no readable robots file; the standard treats it as no rules.
    } catch {
      this.log.debug(`robots.txt unreadable for ${origin} — treating as no rules`);
    }
    this.robotsCache.set(origin, body);
    return body;
  }
}

class TooLargeError extends Error {}
class RefusedAddressError extends Error {}

/** Reads a response body, aborting as soon as the byte cap is crossed. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TooLargeError();
      }
      parts.push(value);
    }
  }
  return Buffer.concat(parts);
}

function pdfTitleFromUrl(url: string): string | null {
  try {
    const segment = decodeURIComponent(
      new URL(url).pathname.split('/').filter(Boolean).pop() ?? '',
    );
    return segment || null;
  } catch {
    return null;
  }
}
