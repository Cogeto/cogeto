import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const validEnv = {
  COGETO_DATABASE_URL: 'postgres://postgres:dev@localhost:5432/cogeto',
  COGETO_QDRANT_URL: 'http://localhost:6333',
  COGETO_S3_URL: 'http://localhost:9000',
  COGETO_OIDC_ISSUER: 'https://localhost',
  COGETO_OIDC_INTERNAL_URL: 'http://localhost:8080',
  COGETO_OIDC_EXTERNAL_DOMAIN: 'localhost',
  COGETO_WEB_CONFIG_FILE: '/web-config/config.json',
};

describe('loadConfig', () => {
  it('parses a complete environment and applies defaults', () => {
    const config = loadConfig(validEnv);
    expect(config.httpPort).toBe(3000);
    expect(config.logLevel).toBe('info');
    expect(config.oidc.externalDomain).toBe('localhost');
  });

  it('fails to start on a missing required variable (fail-fast boot)', () => {
    const { COGETO_DATABASE_URL: _omitted, ...incomplete } = validEnv;
    expect(() => loadConfig(incomplete)).toThrow(/databaseUrl/);
  });

  it('rejects a malformed issuer URL', () => {
    expect(() => loadConfig({ ...validEnv, COGETO_OIDC_ISSUER: 'not-a-url' })).toThrow(
      /invalid COGETO_/,
    );
  });
});
