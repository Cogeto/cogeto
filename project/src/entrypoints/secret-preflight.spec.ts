import { describe, expect, it } from 'vitest';
import {
  assertProductionSecrets,
  findKnownDevSecrets,
  isLocalhostDeployment,
} from './secret-preflight';

/** FIX-2 QS-8: refuse known dev secrets on a non-localhost deployment. */
describe('secret preflight (QS-8)', () => {
  const devSecrets = {
    POSTGRES_PASSWORD: 'cogeto-dev-password',
    COGETO_DATABASE_URL: 'postgres://postgres:cogeto-dev-password@postgres:5432/cogeto',
    ZITADEL_MASTERKEY: 'MasterkeyNeedsToHave32Characters',
    ZITADEL_ADMIN_PASSWORD: 'DevPassword1!',
    COGETO_MAIL_INTAKE_TOKEN: 'cogeto-dev-mail-token',
  };

  it('treats localhost / *.localhost / 127.0.0.1 as a dev box', () => {
    expect(isLocalhostDeployment({ COGETO_EXTERNAL_DOMAIN: 'localhost' })).toBe(true);
    expect(isLocalhostDeployment({ COGETO_EXTERNAL_DOMAIN: '127.0.0.1' })).toBe(true);
    expect(isLocalhostDeployment({ COGETO_EXTERNAL_DOMAIN: 's3.localhost' })).toBe(true);
    expect(isLocalhostDeployment({})).toBe(true); // unknown → treat as local
    expect(isLocalhostDeployment({ COGETO_EXTERNAL_DOMAIN: 'cogeto.example.com' })).toBe(false);
  });

  it('is a no-op on a localhost dev box even with every dev secret present', () => {
    expect(() =>
      assertProductionSecrets({ ...devSecrets, COGETO_EXTERNAL_DOMAIN: 'localhost' }),
    ).not.toThrow();
  });

  it('refuses to boot when a dev secret guards a real (non-localhost) deployment', () => {
    const env = { ...devSecrets, COGETO_EXTERNAL_DOMAIN: 'cogeto.example.com' };
    const offenders = findKnownDevSecrets(env);
    expect(offenders).toContain('POSTGRES_PASSWORD');
    expect(offenders).toContain('COGETO_DATABASE_URL'); // matched by substring
    expect(offenders).toContain('ZITADEL_MASTERKEY');
    expect(offenders).toContain('ZITADEL_ADMIN_PASSWORD');
    expect(offenders).toContain('COGETO_MAIL_INTAKE_TOKEN'); // SEC-10/PA-19
    expect(() => assertProductionSecrets(env)).toThrow(/known DEV secret/);
  });

  it('passes on a real deployment once every secret is overridden', () => {
    const env = {
      COGETO_EXTERNAL_DOMAIN: 'cogeto.example.com',
      POSTGRES_PASSWORD: 'S0me-Real-Long-Secret',
      COGETO_DATABASE_URL: 'postgres://postgres:S0me-Real-Long-Secret@db/cogeto',
      ZITADEL_MASTERKEY: 'a-real-32-char-master-key-value!!',
      ZITADEL_ADMIN_PASSWORD: 'aR3al!Admin#Pass',
    };
    expect(findKnownDevSecrets(env)).toEqual([]);
    expect(() => assertProductionSecrets(env)).not.toThrow();
  });

  it('skips secrets that are absent from the environment', () => {
    // Only the DB password is present-and-dev; the rest absent → just that one.
    expect(
      findKnownDevSecrets({
        COGETO_EXTERNAL_DOMAIN: 'cogeto.example.com',
        POSTGRES_PASSWORD: 'cogeto-dev-password',
      }),
    ).toEqual(['POSTGRES_PASSWORD']);
  });
});
