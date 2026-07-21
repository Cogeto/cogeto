import { describe, expect, it } from 'vitest';
import { resolveModelProviders } from '../model-gateway/index';
import { buildModelConfigDto } from './model-config.controller';

/**
 * settings_display_accurate (decision 0040): the read-only Settings section
 * renders the RUNNING configuration truthfully — id, provider/model per tier,
 * redaction posture — and can never leak key material.
 */
describe('settings_display_accurate', () => {
  it('mirrors a configured mixed configuration exactly', () => {
    const modelProviders = resolveModelProviders(
      {
        COGETO_PROVIDER_PRESET: 'anthropic-answer',
        COGETO_ANTHROPIC_API_KEY: 'anthropic-secret-key',
        COGETO_MISTRAL_API_KEY: 'mistral-secret-key',
      } as NodeJS.ProcessEnv,
      { redacted: false },
    );
    const dto = buildModelConfigDto({ modelProviders, redactionEnabled: false });

    expect(dto).toEqual({
      configured: true,
      configurationId: 'anthropic-answer',
      preset: 'anthropic-answer',
      tiers: {
        pipeline: { provider: 'mistral', model: 'mistral-small-latest' },
        answer: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        embeddings: { provider: 'mistral', model: 'mistral-embed' },
      },
      redactionEnabled: false,
      externalCalls: expect.stringMatching(/Mistral and Anthropic/) as unknown,
    });
    // No key input, no key output: the DTO carries no secret material.
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('anthropic-secret-key');
    expect(serialized).not.toContain('mistral-secret-key');
    expect(serialized.toLowerCase()).not.toContain('apikey');
  });

  it('states the redaction posture in the external-calls sentence', () => {
    const modelProviders = resolveModelProviders(
      { COGETO_MISTRAL_API_KEY: 'k' } as NodeJS.ProcessEnv,
      { redacted: true },
    );
    const dto = buildModelConfigDto({ modelProviders, redactionEnabled: true });
    expect(dto.configurationId).toBe('mistral-default-redacted');
    expect(dto.redactionEnabled).toBe(true);
    expect(dto.externalCalls).toMatch(/redaction pseudonymizes/);
    expect(dto.externalCalls).toMatch(/Mistral/);
  });

  it('an unconfigured instance says so honestly', () => {
    const modelProviders = resolveModelProviders({} as NodeJS.ProcessEnv, { redacted: false });
    const dto = buildModelConfigDto({ modelProviders, redactionEnabled: false });
    expect(dto.configured).toBe(false);
    expect(dto.configurationId).toBe('unconfigured');
    expect(dto.externalCalls).toMatch(/No model provider is configured/);
  });
});
