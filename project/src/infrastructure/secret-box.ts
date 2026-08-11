import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Secret encryption at rest under the instance master key (V2.4 item 7.1,
 * generalized for V2.5 item 8.1).
 *
 * Born as the provider-key mechanism and moved here when connector
 * credentials needed the same guarantee: ONE sealed-secret mechanism, never a
 * second. The rule is exact: secrets are encrypted in the database, the
 * master key stays in the environment. That split is the whole point — a
 * database dump, a backup, a replica, or a support export contains ciphertext
 * and nothing else, and the one thing that opens it is not in there with it.
 *
 * Every sealed column is opened in exactly one function, asserted
 * structurally by that column's own confinement spec (`key-confinement`,
 * `credential-confinement`, `webhook-secret-confinement`).
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to open rather
 * than decrypting to garbage that gets sent to an endpoint as a bearer token.
 * A fresh 96-bit IV per encryption, which is what GCM requires and why a key is
 * re-encrypted rather than patched when it changes.
 *
 * The stored form is `v1.<iv>.<tag>.<ciphertext>`, base64url per part. Versioned
 * from the first byte so a future rotation to another algorithm can read what
 * this one wrote instead of guessing.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

/**
 * The instance master key, read from the environment.
 *
 * Absent is NOT a failure by itself: an instance with no provider key to store
 * (the self-hosted deployment with no auth is the ordinary case) never needs
 * one, and demanding a meaningless value from every operator would be friction
 * with no safety in it. It becomes a failure at the exact moment something asks
 * to encrypt, and then it says so with the command that generates one.
 */
export function readMasterKey(env: NodeJS.ProcessEnv): Buffer | null {
  const raw = env.COGETO_MASTER_KEY?.trim();
  if (!raw) return null;
  const decoded = decodeKey(raw);
  if (decoded.length !== KEY_BYTES) {
    throw new MasterKeyError(
      `COGETO_MASTER_KEY must decode to ${KEY_BYTES} bytes (got ${decoded.length}): ` +
        `generate one with \`openssl rand -base64 32\``,
    );
  }
  return decoded;
}

function decodeKey(raw: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return Buffer.from(raw, 'base64');
}

/** The message an operator sees when a key must be stored and cannot be. */
export const MASTER_KEY_MISSING =
  'COGETO_MASTER_KEY is not set, so a secret cannot be encrypted and will not be ' +
  'stored in plaintext. Generate one with `openssl rand -base64 32`, put it in .env as ' +
  'COGETO_MASTER_KEY, and restart. It never changes after that: rotating it makes every ' +
  'stored secret unreadable.';

/**
 * Encrypt a secret. Throws when there is no master key, rather than
 * storing a secret in the clear — the one behaviour that must not be
 * configurable.
 */
export function sealSecret(masterKey: Buffer | null, plaintext: string): string {
  if (!masterKey) throw new MasterKeyError(MASTER_KEY_MISSING);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, b64(iv), b64(tag), b64(ciphertext)].join('.');
}

export class SecretUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretUnreadableError';
  }
}

/**
 * Decrypt a stored secret. Called only where the secret is about to be used —
 * each sealed column's single opening function — and nowhere else.
 *
 * A failure here is loud and specific: a wrong or rotated master key makes
 * every stored secret unreadable at once, and an instance that silently sent
 * an empty bearer token to an upstream would look like an upstream outage.
 */
export function openSecret(masterKey: Buffer | null, sealed: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretUnreadableError(
      'a stored secret is not in the expected sealed format: it was written by a ' +
        'different version of this software, or the column was edited by hand',
    );
  }
  if (!masterKey) throw new MasterKeyError(MASTER_KEY_MISSING);
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      masterKey,
      Buffer.from(parts[1]!, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3]!, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretUnreadableError(
      'a stored secret could not be decrypted with COGETO_MASTER_KEY. The master key ' +
        'has changed, or the value was replaced. Re-enter the secret where it was ' +
        'configured; nothing else can recover it.',
    );
  }
}

/** True when two keys are the same, without leaking length by early exit. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

const b64 = (buffer: Buffer): string => buffer.toString('base64url');
