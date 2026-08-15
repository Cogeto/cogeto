import { describe, expect, it } from 'vitest';
import {
  assertProductionSecrets,
  assertProfileSecrets,
  findEmptyProfileSecrets,
  findKnownDevSecrets,
  isLocalhostDeployment,
  PROFILE_REQUIRED_SECRETS,
} from './secret-preflight';

/**: refuse known dev secrets on a non-localhost deployment. */
describe('secret preflight', () => {
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
    expect(offenders).toContain('COGETO_MAIL_INTAKE_TOKEN'); ///PA-19
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

/**
 * F12: an ACTIVE profile whose secret is EMPTY. The pass above cannot see this
 * case — it skips empty values so that a process handed a subset of the secrets
 * does not flag the ones it was not given — and the composes supply an empty
 * default deliberately, because compose interpolates the whole file before
 * profile filtering.
 */
describe('active-profile secret refusal (audit F12)', () => {
  const deployed = { COGETO_EXTERNAL_DOMAIN: 'cogeto.example.com' };

  it('is a no-op when the profile is not active, whatever the secret is', () => {
    for (const env of [
      { ...deployed },
      { ...deployed, SEARXNG_SECRET: '' },
      { ...deployed, COGETO_COMPOSE_PROFILES: 'mail,redaction', SEARXNG_SECRET: '' },
    ]) {
      expect(findEmptyProfileSecrets(env)).toEqual([]);
      expect(() => assertProfileSecrets(env)).not.toThrow();
    }
  });

  it('refuses an active research profile with an empty or unset secret', () => {
    for (const env of [
      { ...deployed, COGETO_COMPOSE_PROFILES: 'research' },
      { ...deployed, COGETO_COMPOSE_PROFILES: 'mail, research ', SEARXNG_SECRET: '' },
      { ...deployed, COGETO_COMPOSE_PROFILES: 'research', SEARXNG_SECRET: '   ' },
      // The explicit capability flag activates it too: a CLI `--profile
      // research` run is invisible to the container, which is why the flag
      // exists at all.
      { ...deployed, COGETO_RESEARCH_ENABLED: '1', SEARXNG_SECRET: '' },
    ]) {
      expect(findEmptyProfileSecrets(env)).toEqual(['SEARXNG_SECRET']);
      expect(() => assertProfileSecrets(env)).toThrow(/SEARXNG_SECRET.*profile 'research'/s);
    }
  });

  it('passes once the active profile has a real secret', () => {
    const env = {
      ...deployed,
      COGETO_COMPOSE_PROFILES: 'research',
      SEARXNG_SECRET: 'b8bd1a2c9f6e4d3a8c7b5e2f1d0a9c8b',
    };
    expect(findEmptyProfileSecrets(env)).toEqual([]);
    expect(() => assertProfileSecrets(env)).not.toThrow();
  });

  it('applies on a localhost box too — an empty secret is not a dev default', () => {
    // The dev compose ships a working default, so blanking it is deliberate.
    const env = { COGETO_EXTERNAL_DOMAIN: 'localhost', COGETO_COMPOSE_PROFILES: 'research' };
    expect(() => assertProfileSecrets(env)).toThrow(/empty/);
    // …while the dev DEFAULT value is refused only off localhost, as before.
    const withDevDefault = { ...env, SEARXNG_SECRET: 'cogeto-dev-searxng-secret' };
    expect(() => assertProfileSecrets(withDevDefault)).not.toThrow();
    expect(() => assertProductionSecrets(withDevDefault)).not.toThrow();
    expect(() =>
      assertProductionSecrets({ ...withDevDefault, COGETO_EXTERNAL_DOMAIN: 'cogeto.example.com' }),
    ).toThrow(/SEARXNG_SECRET/);
  });

  it('every profile-required secret names a real compose profile and a reason', () => {
    for (const secret of PROFILE_REQUIRED_SECRETS) {
      expect(['research', 'mail', 'redaction']).toContain(secret.profile);
      expect(secret.why.length).toBeGreaterThan(20);
    }
  });
});
