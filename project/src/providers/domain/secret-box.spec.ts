import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MASTER_KEY_MISSING,
  MasterKeyError,
  openSecret,
  readMasterKey,
  sealSecret,
  SecretUnreadableError,
} from './secret-box';

/**
 * Provider keys at rest (V2.4 item 7.1). The properties asserted here are the
 * ones the plan states as rules rather than preferences: encrypted with the
 * instance master key, which stays in the environment; never stored in the
 * clear; and a failure to decrypt is loud rather than an empty bearer token
 * sent to a provider.
 */
describe('secret_box: provider keys are encrypted at rest', () => {
  const key = randomBytes(32);

  it('key_roundtrip: what was sealed comes back exactly', () => {
    const sealed = sealSecret(key, 'sk-live-abc123');
    expect(openSecret(key, sealed)).toBe('sk-live-abc123');
  });

  it('ciphertext_carries_no_plaintext: the stored value contains no fragment of the key', () => {
    const sealed = sealSecret(key, 'sk-live-abc123');
    expect(sealed).not.toContain('sk-live');
    expect(sealed).not.toContain('abc123');
    // Versioned from the first byte, so a future algorithm can read this one.
    expect(sealed.startsWith('v1.')).toBe(true);
  });

  it('fresh_iv_per_seal: the same key sealed twice produces two different values', () => {
    // GCM requires it; a repeated IV under one key is a real break, not a nit.
    expect(sealSecret(key, 'same')).not.toBe(sealSecret(key, 'same'));
  });

  it('refuses_plaintext_storage: no master key means no storage, never a fallback', () => {
    expect(() => sealSecret(null, 'sk-live-abc123')).toThrow(MasterKeyError);
    expect(() => sealSecret(null, 'sk-live-abc123')).toThrow(/openssl rand -base64 32/);
    expect(MASTER_KEY_MISSING).toContain('COGETO_MASTER_KEY');
  });

  it('tampered_ciphertext_fails_closed: an edited value does not decrypt to anything', () => {
    const sealed = sealSecret(key, 'sk-live-abc123');
    const parts = sealed.split('.');
    // Flip a byte in the ciphertext; GCM's tag must catch it.
    const body = Buffer.from(parts[3]!, 'base64url');
    body[0] = body[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], body.toString('base64url')].join('.');
    expect(() => openSecret(key, tampered)).toThrow(SecretUnreadableError);
  });

  it('rotated_master_key_says_so: the failure names the cause and the only fix', () => {
    const sealed = sealSecret(key, 'sk-live-abc123');
    expect(() => openSecret(randomBytes(32), sealed)).toThrow(/master key has changed/);
  });

  it('reads_base64_and_hex, and refuses a key of the wrong size', () => {
    expect(readMasterKey({ COGETO_MASTER_KEY: key.toString('base64') })).toEqual(key);
    expect(readMasterKey({ COGETO_MASTER_KEY: key.toString('hex') })).toEqual(key);
    // Absent is fine: an instance with nothing to encrypt needs no master key.
    expect(readMasterKey({})).toBeNull();
    expect(() => readMasterKey({ COGETO_MASTER_KEY: 'dGlueQ==' })).toThrow(MasterKeyError);
  });
});
