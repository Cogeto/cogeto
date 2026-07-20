import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * The instance signing keypair (§B.1, decision 0008): one ed25519 key per
 * instance, generated at first boot by the migrate init job into a dedicated
 * volume — never into the repo or the image. Deletion receipts are signed with
 * the private key; the public key is served at GET /api/instance/public-key so
 * anyone holding a receipt can verify it independently.
 *
 * Node's crypto module suffices — ed25519 keygen/sign/verify are built in.
 */

export const PRIVATE_KEY_FILE = 'instance-signing-key.pem';
export const PUBLIC_KEY_FILE = 'instance-signing-key.pub.pem';

export interface InstanceSigner {
  /** SPKI PEM — the shareable half, served over the API. */
  publicKeyPem: string;
  /** ed25519 signature over the raw bytes, base64. */
  sign(data: Buffer | string): string;
  verify(data: Buffer | string, signatureBase64: string): boolean;
}

/**
 * Generates the keypair if absent; a no-op when both files already exist.
 * Only the migrate init job (and bare local runs) call this with a writable
 * directory — app and worker mount the volume read-only and just load.
 */
export async function ensureInstanceKeys(dir: string): Promise<void> {
  const privatePath = path.join(dir, PRIVATE_KEY_FILE);
  const publicPath = path.join(dir, PUBLIC_KEY_FILE);
  if (await exists(privatePath)) {
    if (!(await exists(publicPath))) {
      // Recoverable half-state: re-derive the public key from the private one.
      const privateKey = createPrivateKey(await readFile(privatePath, 'utf8'));
      await writeFile(publicPath, exportPublicPem(privateKey), { mode: 0o644 });
    }
    return;
  }
  await mkdir(dir, { recursive: true });
  const { privateKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  // Write the public key first: if we crash between the writes, the retry path
  // above regenerates the missing half instead of leaving a torn pair.
  await writeFile(publicPath, exportPublicPem(privateKey), { mode: 0o644 });
  await writeFile(privatePath, privatePem, { mode: 0o600 });
  await chmod(privatePath, 0o600);
}

/** Loads the signer; throws with guidance when the keypair is missing. */
export async function loadInstanceSigner(dir: string): Promise<InstanceSigner> {
  const privatePem = await readKey(path.join(dir, PRIVATE_KEY_FILE));
  const privateKey = createPrivateKey(privatePem);
  const publicKeyPem = exportPublicPem(privateKey);
  const publicKey = createPublicKey(privateKey);
  return {
    publicKeyPem,
    sign: (data) => sign(null, toBuffer(data), privateKey).toString('base64'),
    verify: (data, signatureBase64) =>
      verify(null, toBuffer(data), publicKey, Buffer.from(signatureBase64, 'base64')),
  };
}

/** Public key only — what the app process needs to serve and verify. */
export async function loadInstancePublicKey(dir: string): Promise<string> {
  return readKey(path.join(dir, PUBLIC_KEY_FILE));
}

/**
 * QS-9 boot assertion for the internet-facing app: the receipt-signing PRIVATE
 * key must not be reachable at the key dir (the app mounts a public-key-only
 * volume). Throws if the private key file is present — a misconfigured mount
 * that would let an app-side RCE forge "provably deleted" receipts. Also
 * verifies the public key IS present (the app needs it to verify receipts).
 */
export async function assertAppKeyMount(dir: string): Promise<void> {
  if (await exists(path.join(dir, PRIVATE_KEY_FILE))) {
    throw new Error(
      `the private signing key is readable at ${dir} — the app must mount only the ` +
        `public half (QS-9). Check the instance-pubkey volume mount.`,
    );
  }
  if (!(await exists(path.join(dir, PUBLIC_KEY_FILE)))) {
    throw new Error(
      `the instance public key is missing at ${dir} — the migrate job publishes it ` +
        `(COGETO_INSTANCE_PUBKEY_DIR, QS-9)`,
    );
  }
}

/** Pure verification against a PEM public key — receipt-chain verification. */
export function verifyWithPublicKey(
  publicKeyPem: string,
  data: Buffer | string,
  signatureBase64: string,
): boolean {
  return verify(
    null,
    toBuffer(data),
    createPublicKey(publicKeyPem),
    Buffer.from(signatureBase64, 'base64'),
  );
}

function exportPublicPem(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) as string;
}

function toBuffer(data: Buffer | string): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
}

async function readKey(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(
      `instance signing key not found at ${file} — the migrate init job generates it ` +
        `on first boot (COGETO_INSTANCE_KEY_DIR, decision 0008): ${String(error)}`,
      { cause: error },
    );
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}
