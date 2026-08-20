import { describe, expect, it } from 'vitest';
import { createModelGateway } from '../model-gateway/index';
import type { ModelGateway, ResolvedModelProviders, TierBinding } from '../model-gateway/index';
import { ambiguityThresholdsFor } from './ambiguity-config';

/**
 * Per-embedding-model calibration under a served name (hosted provisioning,
 * task A). A threshold is a fact about vector geometry; a served name is
 * branding over the model that actually embeds. The lookup therefore keys by
 * `embeddingGeometryId()` while every message carries the served name, so a
 * managed instance answers under its geometry's measured entry and an
 * upstream identifier can never leave through the refusal message.
 *
 * Built through the ordinary factory, so the assertion also covers the
 * endpoint-to-adapter pass-through and the routed gateway's forwarding.
 */

function gatewayWith(aliases?: Readonly<Record<string, string>>): ModelGateway {
  const binding = (model: string): TierBinding => ({
    provider: 'openai',
    model,
    endpoint: {
      id: 'ep-1',
      label: 'Managed',
      baseUrl: 'http://stub.invalid/v1',
      apiKey: 'k',
      selfHosted: true,
      ...(aliases ? { modelAliases: aliases } : {}),
    },
  });
  const providers: ResolvedModelProviders = {
    configured: true,
    id: 'test',
    preset: null,
    tiers: {
      pipeline: binding('served-general'),
      answer: binding('served-general'),
      embedding: binding('served-embed'),
    },
    vision: null,
    keys: {},
    endpoints: { openaiBaseUrl: '', anthropicBaseUrl: '' },
    ollama: null,
    timeoutsMs: { pipeline: 1000, answer: 1000, embedding: 1000, vision: 1000 },
    reasoningHeadroom: 4,
    openaiSelfHosted: true,
    redacted: false,
    source: 'database',
    version: 1,
    answerOptions: [],
  };
  return createModelGateway({ providers });
}

describe('ambiguity_geometry: served names resolve their upstream geometry', () => {
  it('a served name over a measured geometry answers that entry', () => {
    const gateway = gatewayWith({ 'served-embed': 'bge-m3', 'served-general': 'up-general' });
    expect(gateway.embeddingModelId()).toBe('served-embed');
    const thresholds = ambiguityThresholdsFor(
      gateway.embeddingGeometryId(),
      gateway.embeddingModelId(),
    );
    expect(thresholds).toEqual(ambiguityThresholdsFor('bge-m3'));
  });

  it('an unmeasured geometry still fails loudly, naming the served model only', () => {
    const gateway = gatewayWith({
      'served-embed': 'some-unmeasured-upstream',
      'served-general': 'up-general',
    });
    let message = '';
    try {
      ambiguityThresholdsFor(gateway.embeddingGeometryId(), gateway.embeddingModelId());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('served-embed');
    expect(message).not.toContain('some-unmeasured-upstream');
  });

  it('an alias-free binding is byte-identical: geometry id IS the model id', () => {
    const gateway = gatewayWith();
    expect(gateway.embeddingGeometryId()).toBe(gateway.embeddingModelId());
    expect(gateway.embeddingGeometryId()).toBe('served-embed');
  });
});
