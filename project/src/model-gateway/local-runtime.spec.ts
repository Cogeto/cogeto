import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertLocalRuntimeReady, modelAvailable } from './local-runtime';
import { resolveModelProviders } from './provider-config';

/**
 * boot_probe (decision 0041 ruling 2): an unreachable local runtime or a
 * never-pulled model refuses startup with the exact fix — never a first-request
 * failure. Mocked fetch; no network.
 */

const providers = (vars: Record<string, string>) =>
  resolveModelProviders(vars as NodeJS.ProcessEnv, { redacted: false });

const OLLAMA_ENV = {
  COGETO_PROVIDER_PRESET: 'ollama-local',
  COGETO_OLLAMA_BASE_URL: 'http://10.0.0.1:11434',
};

const tags = (...names: string[]): Response =>
  new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('boot_probe', () => {
  it('an unreachable runtime fails startup naming the URL and the variable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new TypeError('fetch failed: ECONNREFUSED');
      }),
    );
    await expect(assertLocalRuntimeReady(providers(OLLAMA_ENV))).rejects.toThrow(
      /Ollama runtime unreachable at http:\/\/10\.0\.0\.1:11434 .*COGETO_OLLAMA_BASE_URL/,
    );
  });

  it('a non-2xx tags response is unreachable too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 502 })),
    );
    await expect(assertLocalRuntimeReady(providers(OLLAMA_ENV))).rejects.toThrow(
      /Ollama runtime unreachable .*HTTP 502/,
    );
  });

  it('a missing model fails startup with the exact ollama pull command', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tags('bge-m3:latest')),
    );
    await expect(assertLocalRuntimeReady(providers(OLLAMA_ENV))).rejects.toThrow(
      /model "gemma3:12b" is not available on the Ollama runtime at http:\/\/10\.0\.0\.1:11434 — run `ollama pull gemma3:12b`/,
    );
  });

  it('passes when every bound model is pulled (tag-suffix tolerant)', async () => {
    const probe = vi.fn(async () => tags('gemma3:12b', 'bge-m3:latest'));
    vi.stubGlobal('fetch', probe);
    await expect(assertLocalRuntimeReady(providers(OLLAMA_ENV))).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledWith(
      'http://10.0.0.1:11434/api/tags',
      expect.objectContaining({ signal: expect.anything() as AbortSignal }),
    );
  });

  it('is a no-op for hosted configurations and unconfigured instances', async () => {
    const probe = vi.fn();
    vi.stubGlobal('fetch', probe);
    await assertLocalRuntimeReady(providers({ COGETO_MISTRAL_API_KEY: 'k' }));
    await assertLocalRuntimeReady(providers({}));
    expect(probe).not.toHaveBeenCalled();
  });

  it('modelAvailable matches exact tags and bare names, never the reverse (pure)', () => {
    expect(modelAvailable('bge-m3', ['bge-m3:latest'])).toBe(true);
    expect(modelAvailable('gemma3:12b', ['gemma3:12b'])).toBe(true);
    expect(modelAvailable('gemma3:12b', ['gemma3:27b'])).toBe(false);
    // A tagged requirement must match exactly — :latest is not :12b.
    expect(modelAvailable('gemma3:12b', ['gemma3:latest'])).toBe(false);
    expect(modelAvailable('bge-m3', [])).toBe(false);
  });
});
