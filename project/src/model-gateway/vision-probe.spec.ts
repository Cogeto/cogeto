import { describe, expect, it } from 'vitest';
import { ModelGateway } from './model-gateway.service';
import type { CompletionResult, VisionRequest } from './model-gateway.service';
import { VisionUnavailableError } from './errors';
import { probeImagePng, probeVision } from './vision-probe';
import { classifyVisionFailure } from './vision-failure';
import { ProviderHttpError } from './provider';
import { resolveModelProviders } from './provider-config';

/**
 * The probe exists because a model's NAME cannot answer the question. These
 * tests pin the two properties that make it worth having: it sends a real
 * image, and it tells the four failure cases apart, because each sends an
 * operator somewhere different.
 */

class StubGateway extends ModelGateway {
  lastRequest?: VisionRequest;
  constructor(private readonly behaviour: (request: VisionRequest) => CompletionResult) {
    super();
  }
  complete(): never {
    throw new Error('unused');
  }
  // eslint-disable-next-line require-yield -- unused by the probe
  async *completeStream(): AsyncIterable<string> {
    throw new Error('unused');
  }
  extractStructured(): never {
    throw new Error('unused');
  }
  async embed(): Promise<number[][]> {
    return [];
  }
  embeddingModelId(): string {
    return 'stub';
  }
  override async describeImage(request: VisionRequest): Promise<CompletionResult> {
    this.lastRequest = request;
    return this.behaviour(request);
  }
}

const VISION_ENV = {
  COGETO_MISTRAL_API_KEY: 'k',
  COGETO_PROVIDER_VISION: 'ollama',
  COGETO_MODEL_VISION: 'llava:13b',
  COGETO_OLLAMA_BASE_URL: 'http://10.0.0.1:11434',
};
const providersWithVision = () => resolveModelProviders(VISION_ENV, { redacted: false });
const providersWithoutVision = () =>
  resolveModelProviders({ COGETO_MISTRAL_API_KEY: 'k' }, { redacted: false });

describe('the probe image', () => {
  it('is a real PNG built in code, not a fixture on disk', () => {
    const png = probeImagePng();
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.includes(Buffer.from('IHDR', 'latin1'))).toBe(true);
    expect(png.includes(Buffer.from('IEND', 'latin1'))).toBe(true);
    // Small enough that probing at boot and on every capability poll is free.
    expect(png.length).toBeLessThan(2048);
  });
});

describe('probeVision', () => {
  it('sends an actual image through the gateway, never inspects a model name', async () => {
    const gateway = new StubGateway(() => ({ text: 'A blue square with a lighter band.' }));
    const result = await probeVision(gateway, providersWithVision());

    expect(result.ok).toBe(true);
    expect(gateway.lastRequest?.image.bytes.length).toBeGreaterThan(0);
    expect(gateway.lastRequest?.image.mediaType).toBe('image/png');
    expect(result.detail).toContain('ollama/llava:13b');
  });

  it('reports a missing binding as not configured, with what to set', async () => {
    const gateway = new StubGateway(() => ({ text: 'unused' }));
    const result = await probeVision(gateway, providersWithoutVision());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_configured');
    expect(result.error).toContain('COGETO_PROVIDER_VISION');
    // The consequence is stated, not just the missing variable.
    expect(result.error).toContain('labelled');
  });

  it('reports an empty answer as unusable rather than as success', async () => {
    const gateway = new StubGateway(() => ({ text: '   ' }));
    const result = await probeVision(gateway, providersWithVision());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unusable_response');
  });

  it('passes a classified failure through with its reason intact', async () => {
    const gateway = new StubGateway(() => {
      throw new VisionUnavailableError('image_rejected', 'the projector is not loaded');
    });
    const result = await probeVision(gateway, providersWithVision());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('image_rejected');
    expect(result.error).toContain('projector');
  });
});

describe('failure classification', () => {
  const local = {
    label: 'ollama',
    model: 'gemma3:12b',
    endpoint: 'http://10.0.0.1:11434/v1',
    localRuntime: true,
  };

  it('names the multimodal projector when a local runtime refuses the image', () => {
    const refusal = new ProviderHttpError('unknown field "image_url"', 400);
    const classified = classifyVisionFailure(refusal, local);

    expect(classified.reason).toBe('image_rejected');
    // The whole point: an operator told "the model rejected the image" checks
    // the image. This sends them to the Modelfile instead.
    expect(classified.error ?? classified.message).toMatch(/MULTIMODAL PROJECTOR/);
    expect(classified.message).toContain('mmproj');
    expect(classified.message).toContain('COGETO_MODEL_VISION');
  });

  it('does not blame a projector on a hosted provider', () => {
    const classified = classifyVisionFailure(new ProviderHttpError('bad request', 400), {
      ...local,
      label: 'openai',
      localRuntime: false,
    });
    expect(classified.reason).toBe('image_rejected');
    expect(classified.message).not.toMatch(/projector/i);
    expect(classified.message).toContain('not a vision model');
  });

  it('tells an endpoint that is down from one that refused the image', () => {
    expect(classifyVisionFailure(new Error('fetch failed: ECONNREFUSED'), local).reason).toBe(
      'unreachable',
    );
    expect(
      classifyVisionFailure(new Error('the call timed out after 600000 ms'), local).reason,
    ).toBe('unreachable');
  });

  it('treats a server error as an unusable response, not a missing capability', () => {
    expect(classifyVisionFailure(new ProviderHttpError('upstream boom', 502), local).reason).toBe(
      'unusable_response',
    );
  });

  it('reports bad credentials as unreachable rather than as a rejected image', () => {
    expect(classifyVisionFailure(new ProviderHttpError('unauthorized', 401), local).reason).toBe(
      'unreachable',
    );
  });
});
