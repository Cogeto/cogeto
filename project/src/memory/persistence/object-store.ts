import { createHash, createHmac } from 'node:crypto';

/**
 * The object-storage side of the memory module (decision 0003 ruling 2: the
 * memory module owns ALL storage access for memory data — file bytes included;
 * decision 0008). A minimal S3 SigV4 client over fetch + node:crypto: the
 * deletion saga's object removal, the seed fixture's upload, the bucket
 * encryption check AND (O1, decision 0014) the file-upload put/get + presigned
 * download URL. A handful of operations, which does not justify a full SDK
 * dependency (owner sign-off would be required for one).
 *
 * MinIO-specific assumptions, fine for the single-tenant stack (§A.2):
 * path-style addressing and the default region.
 */

const REGION = 'us-east-1';
const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface ObjectStoreOptions {
  /** e.g. http://minio:9000 — the endpoint the server makes S3 calls against. */
  url: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  /**
   * Browser-reachable origin used ONLY when signing presigned download URLs
   * (§A.9). Defaults to `url`; set it when MinIO's internal hostname is not
   * reachable from the browser (the usual case behind an edge proxy). The host
   * MinIO ultimately receives must match this origin's host, so the deployment
   * must proxy it with the Host header preserved (see the O1 owner checklist).
   */
  publicUrl?: string;
}

/** Upload-time metadata carried alongside the bytes (O1). */
export interface PutObjectOptions {
  /** Stored as the object's Content-Type; echoed back on GET/HEAD. */
  contentType?: string;
  /**
   * Arbitrary user metadata, stored as `x-amz-meta-<key>` headers. Values must
   * be US-ASCII (S3 rule) — callers URL-encode anything that is not.
   */
  metadata?: Record<string, string>;
}

export interface FetchedObject {
  body: Buffer;
  contentType: string | null;
  metadata: Record<string, string>;
}

export interface ObjectStat {
  contentType: string | null;
  sizeBytes: number | null;
  metadata: Record<string, string>;
}

export interface PresignOptions {
  /** response-content-disposition: attachment; filename="…" — nicer downloads. */
  filename?: string;
  /** Overrides the response Content-Type (else the stored one is served). */
  contentType?: string;
}

export class MemoryObjectStore {
  private readonly base: URL;
  /** Origin used to build presigned URLs — may differ from the API endpoint. */
  private readonly publicBase: URL;

  constructor(private readonly options: ObjectStoreOptions) {
    this.base = new URL(options.url);
    this.publicBase = new URL(options.publicUrl ?? options.url);
  }

  get bucket(): string {
    return this.options.bucket;
  }

  async putObject(key: string, body: Buffer | string, opts: PutObjectOptions = {}): Promise<void> {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const extraHeaders: Record<string, string> = {};
    if (opts.contentType) extraHeaders['content-type'] = opts.contentType;
    for (const [name, value] of Object.entries(opts.metadata ?? {})) {
      extraHeaders[`x-amz-meta-${name.toLowerCase()}`] = value;
    }
    const response = await this.request('PUT', this.objectPath(key), '', payload, extraHeaders);
    if (!response.ok) throw await this.asError('putObject', key, response);
  }

  /** Reads the bytes plus the stored content type and user metadata (O1). */
  async getObject(key: string): Promise<FetchedObject> {
    const response = await this.request('GET', this.objectPath(key), '');
    if (!response.ok) throw await this.asError('getObject', key, response);
    const body = Buffer.from(await response.arrayBuffer());
    return {
      body,
      contentType: response.headers.get('content-type'),
      metadata: readMetadata(response.headers),
    };
  }

  /** HEAD: the drawer's file facts without downloading the bytes. Null = 404. */
  async statObject(key: string): Promise<ObjectStat | null> {
    const response = await this.request('HEAD', this.objectPath(key), '');
    if (response.status === 404) return null;
    if (!response.ok) throw await this.asError('statObject', key, response);
    const length = response.headers.get('content-length');
    return {
      contentType: response.headers.get('content-type'),
      sizeBytes: length === null ? null : Number(length),
      metadata: readMetadata(response.headers),
    };
  }

  /** True deletion contract (§A.7): an absent object is success, not an error. */
  async deleteObject(key: string): Promise<void> {
    const response = await this.request('DELETE', this.objectPath(key), '');
    // S3 DELETE returns 204 even for keys that do not exist.
    if (!response.ok && response.status !== 404) {
      throw await this.asError('deleteObject', key, response);
    }
  }

  async objectExists(key: string): Promise<boolean> {
    const response = await this.request('HEAD', this.objectPath(key), '');
    if (response.status === 404) return false;
    if (!response.ok) throw await this.asError('objectExists', key, response);
    return true;
  }

  /**
   * A short-lived SigV4 presigned GET URL (§A.9): the download link the source
   * drawer hands the browser. Signing is offline (no network) — only the host
   * header is signed, the payload is UNSIGNED. The controller gates WHO may
   * call this (owner-only; sensitive files never leave the owner — 0003).
   */
  presignGetUrl(key: string, expiresSeconds: number, opts: PresignOptions = {}): string {
    const { amzDate, dateStamp } = amzTimestamp(new Date());
    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const signedHeaders = 'host';

    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.options.accessKey}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresSeconds),
      'X-Amz-SignedHeaders': signedHeaders,
    };
    if (opts.filename) {
      query['response-content-disposition'] =
        `attachment; filename="${opts.filename.replace(/["\\]/g, '_')}"`;
    }
    if (opts.contentType) query['response-content-type'] = opts.contentType;

    const canonicalQuery = canonicalQueryString(query);
    const canonicalPath = this.objectPath(key);
    // Sign against the PUBLIC host (what the browser will send), not the
    // internal API host — otherwise MinIO's SigV4 host check fails.
    const canonicalHeaders = `host:${this.publicBase.host}\n`;
    const canonicalRequest = [
      'GET',
      canonicalPath,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      UNSIGNED_PAYLOAD,
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
    ].join('\n');
    const signature = createHmac('sha256', this.signingKey(dateStamp))
      .update(stringToSign)
      .digest('hex');

    return `${this.publicBase.origin}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  /**
   * Does the bucket report default encryption (SSE-S3)? The compose stack turns
   * it on in minio-init (`mc encrypt set`); this is the programmatic assertion
   * surfaced in the health check (§A.9, audit 3.9).
   */
  async encryptionEnabled(): Promise<boolean> {
    const response = await this.request('GET', `/${this.options.bucket}`, 'encryption=');
    if (response.status === 404) return false; // ServerSideEncryptionConfigurationNotFoundError
    if (!response.ok) throw await this.asError('encryptionEnabled', this.options.bucket, response);
    return (await response.text()).includes('<SSEAlgorithm>');
  }

  // ── Test/dev-only helpers (integration harness + seed fixture) ─────────────

  async ensureBucket(): Promise<void> {
    const head = await this.request('HEAD', `/${this.options.bucket}`, '');
    if (head.ok) return;
    const response = await this.request('PUT', `/${this.options.bucket}`, '');
    if (!response.ok && response.status !== 409) {
      throw await this.asError('ensureBucket', this.options.bucket, response);
    }
  }

  /** Sets default SSE-S3 bucket encryption — the test-side mirror of minio-init. */
  async setBucketEncryption(): Promise<void> {
    const body = Buffer.from(
      '<ServerSideEncryptionConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        '<Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm>' +
        '</ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>',
      'utf8',
    );
    const response = await this.request('PUT', `/${this.options.bucket}`, 'encryption=', body);
    if (!response.ok) {
      throw await this.asError('setBucketEncryption', this.options.bucket, response);
    }
  }

  // ── SigV4 plumbing ──────────────────────────────────────────────────────────

  private objectPath(key: string): string {
    // Encode each segment, keep the / separators (S3 canonical URI rules).
    const encoded = key.split('/').map(encodeS3Segment).join('/');
    return `/${this.options.bucket}/${encoded}`;
  }

  /** The dateStamp-scoped HMAC signing key (SigV4 key derivation). */
  private signingKey(dateStamp: string): Buffer {
    let key: Buffer = Buffer.from(`AWS4${this.options.secretKey}`, 'utf8');
    for (const part of [dateStamp, REGION, SERVICE, 'aws4_request']) {
      key = createHmac('sha256', key).update(part).digest();
    }
    return key;
  }

  private async request(
    method: string,
    canonicalPath: string,
    canonicalQuery: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const { amzDate, dateStamp } = amzTimestamp(new Date());
    const payloadHash = sha256Hex(body ?? Buffer.alloc(0));

    const headers: Record<string, string> = {
      host: this.base.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      // Extra headers (content-type, x-amz-meta-*) are lowercased and signed.
      ...Object.fromEntries(
        Object.entries(extraHeaders).map(([name, value]) => [name.toLowerCase(), value]),
      ),
    };
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join('');
    const signedHeaders = signedHeaderNames.join(';');

    const canonicalRequest = [
      method,
      canonicalPath,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
    ].join('\n');
    const signature = createHmac('sha256', this.signingKey(dateStamp))
      .update(stringToSign)
      .digest('hex');

    const url = `${this.base.origin}${canonicalPath}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
    return fetch(url, {
      method,
      headers: {
        ...headers,
        authorization:
          `AWS4-HMAC-SHA256 Credential=${this.options.accessKey}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
  }

  private async asError(op: string, subject: string, response: Response): Promise<Error> {
    const text = await response.text().catch(() => '');
    return new Error(
      `object store ${op}(${subject}) -> HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
    );
  }
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SigV4 timestamps: `20260706T101500Z` and its `20260706` date stamp. */
function amzTimestamp(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** Reads `x-amz-meta-*` response headers back into a plain metadata map. */
function readMetadata(headers: Headers): Record<string, string> {
  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith('x-amz-meta-')) {
      metadata[name.slice('x-amz-meta-'.length).toLowerCase()] = value;
    }
  });
  return metadata;
}

/** Canonical query string: RFC-3986-encoded keys/values, sorted by key. */
function canonicalQueryString(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key]!)}`)
    .join('&');
}

/** S3 canonical URI encoding: RFC 3986, everything except unreserved chars. */
function encodeS3Segment(segment: string): string {
  return encodeRfc3986(segment);
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
