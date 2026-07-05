import { createHash, createHmac } from 'node:crypto';

/**
 * The object-storage side of the memory module (decision 0003 ruling 2: the
 * memory module owns ALL storage access for memory data — file bytes included;
 * decision 0008). A minimal S3 SigV4 client over fetch + node:crypto: the
 * deletion saga's object removal, the seed fixture's upload, and the bucket
 * encryption check need exactly five operations, which does not justify a
 * full SDK dependency (owner sign-off would be required for one).
 *
 * MinIO-specific assumptions, fine for the single-tenant stack (§A.2):
 * path-style addressing and the default region.
 */

const REGION = 'us-east-1';
const SERVICE = 's3';

export interface ObjectStoreOptions {
  /** e.g. http://minio:9000 */
  url: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export class MemoryObjectStore {
  private readonly base: URL;

  constructor(private readonly options: ObjectStoreOptions) {
    this.base = new URL(options.url);
  }

  get bucket(): string {
    return this.options.bucket;
  }

  async putObject(key: string, body: Buffer | string): Promise<void> {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const response = await this.request('PUT', this.objectPath(key), '', payload);
    if (!response.ok) throw await this.asError('putObject', key, response);
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

  private async request(
    method: string,
    canonicalPath: string,
    canonicalQuery: string,
    body?: Buffer,
  ): Promise<Response> {
    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body ?? Buffer.alloc(0));

    const headers: Record<string, string> = {
      host: this.base.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
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

    let key: Buffer = Buffer.from(`AWS4${this.options.secretKey}`, 'utf8');
    for (const part of [dateStamp, REGION, SERVICE, 'aws4_request']) {
      key = createHmac('sha256', key).update(part).digest();
    }
    const signature = createHmac('sha256', key).update(stringToSign).digest('hex');

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

/** S3 canonical URI encoding: RFC 3986, everything except unreserved chars. */
function encodeS3Segment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
