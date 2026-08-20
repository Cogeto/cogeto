import { describe, expect, it } from 'vitest';
import {
  ManagedProviderConfigError,
  parseManagedProviderConfig,
  upstreamIdentityOf,
} from './managed-config';

/**
 * The managed configuration contract (hosted provisioning, task A): a
 * malformed file refuses with a message naming precisely what is wrong, and a
 * valid one lands in the repo's own vocabulary. Never guess, never partially
 * apply starts here.
 */

const valid = {
  label: 'Cogeto',
  type: 'selfhosted',
  base_url: 'https://models.example.invalid/v1/',
  models: { 'served-fast': 'upstream-a', 'served-embed': 'upstream-b' },
  assign: { pipeline: 'served-fast', answer: 'served-fast', embeddings: 'served-embed' },
  answer_options: ['served-fast'],
};

describe('managed_provider_config: the platform contract', () => {
  it('accepts the contract and normalizes into the repo vocabulary', () => {
    const config = parseManagedProviderConfig(JSON.stringify(valid), '/managed.json');
    expect(config.type).toBe('self_hosted');
    expect(config.baseUrl).toBe('https://models.example.invalid/v1');
    expect(config.models['served-fast']).toBe('upstream-a');
    expect(config.assign.vision).toBeUndefined();
    expect(config.answerOptions).toEqual(['served-fast']);
  });

  it('accepts the repo spelling of the type too', () => {
    const config = parseManagedProviderConfig(
      JSON.stringify({ ...valid, type: 'self_hosted' }),
      '/managed.json',
    );
    expect(config.type).toBe('self_hosted');
  });

  it('refuses non-JSON naming the source', () => {
    expect(() => parseManagedProviderConfig('{nope', '/managed.json')).toThrowError(
      /\/managed.json is not valid JSON/,
    );
  });

  it('refuses an assignment naming a model the map does not serve', () => {
    const broken = { ...valid, assign: { ...valid.assign, pipeline: 'ghost' } };
    expect(() => parseManagedProviderConfig(JSON.stringify(broken), '/managed.json')).toThrowError(
      /assign.pipeline: "ghost" is not one of the served models/,
    );
  });

  it('refuses an answer option outside the map', () => {
    const broken = { ...valid, answer_options: ['ghost'] };
    expect(() => parseManagedProviderConfig(JSON.stringify(broken), '/managed.json')).toThrowError(
      /answer_options.0: "ghost" is not one of the served models/,
    );
  });

  it('refuses an empty model map and a non-http endpoint, naming each field', () => {
    expect(() =>
      parseManagedProviderConfig(
        JSON.stringify({ ...valid, models: {}, assign: {} }),
        '/managed.json',
      ),
    ).toThrowError(ManagedProviderConfigError);
    expect(() =>
      parseManagedProviderConfig(
        JSON.stringify({ ...valid, base_url: 'ftp://models.example.invalid' }),
        '/managed.json',
      ),
    ).toThrowError(/base_url/);
  });

  it('refuses a missing required field naming its path', () => {
    const { assign: _dropped, ...withoutAssign } = valid;
    expect(() =>
      parseManagedProviderConfig(JSON.stringify(withoutAssign), '/managed.json'),
    ).toThrowError(/assign/);
  });
});

describe('managed_provider_config: upstream identity comparison', () => {
  it('answers the map, or the name itself without one', () => {
    expect(upstreamIdentityOf({ served: 'upstream' }, 'served')).toBe('upstream');
    expect(upstreamIdentityOf({ served: 'upstream' }, 'other')).toBe('other');
    expect(upstreamIdentityOf(null, 'served')).toBe('served');
  });
});
