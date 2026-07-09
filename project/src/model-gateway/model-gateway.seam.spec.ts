import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import {
  loadPrompt,
  MistralModelGateway,
  ModelGatewayError,
  ModelGatewayNotConfiguredError,
  recordPromptVersion,
  UnconfiguredModelGateway,
} from './index';

/** Reach the private Mistral client to spy on it — no network is ever touched. */
function clientOf(gateway: MistralModelGateway): {
  chat: {
    complete: (args: unknown) => Promise<unknown>;
    stream: (args: unknown) => Promise<unknown>;
  };
  embeddings: { create: (args: unknown) => Promise<unknown> };
} {
  return (gateway as unknown as { client: ReturnType<typeof clientOf> }).client;
}
const jsonResponse = (content: string) => ({ choices: [{ message: { content } }] });

describe('model-gateway seam — error classification', () => {
  it('ModelGatewayError carries a retryable flag; not-configured is always fatal', () => {
    expect(new ModelGatewayError('x', true).retryable).toBe(true);
    expect(new ModelGatewayError('x', false).retryable).toBe(false);
    expect(new ModelGatewayNotConfiguredError().retryable).toBe(false);
  });

  it('UnconfiguredModelGateway throws not-configured for every method (provider-neutral contract)', async () => {
    const g = new UnconfiguredModelGateway();
    // complete/extractStructured/embed/embeddingModelId throw synchronously.
    expect(() => g.complete({ input: 'x' })).toThrow(ModelGatewayNotConfiguredError);
    expect(() => g.extractStructured(z.object({}), { system: 's', input: 'x' })).toThrow(
      ModelGatewayNotConfiguredError,
    );
    expect(() => g.embed(['x'])).toThrow(ModelGatewayNotConfiguredError);
    expect(() => g.embeddingModelId()).toThrow(ModelGatewayNotConfiguredError);
    // completeStream is an async generator — it throws on first pull.
    await expect(
      (async () => {
        for await (const _ of g.completeStream({ input: 'x' })) void _;
      })(),
    ).rejects.toBeInstanceOf(ModelGatewayNotConfiguredError);
  });

  it('classifies a provider 4xx as fatal (retryable=false), no retry', async () => {
    const g = new MistralModelGateway({ apiKey: 'test' });
    const spy = vi
      .spyOn(clientOf(g).chat, 'complete')
      .mockRejectedValue(Object.assign(new Error('bad request'), { statusCode: 400 }));
    await expect(g.complete({ input: 'q' })).rejects.toMatchObject({ retryable: false });
    expect(spy).toHaveBeenCalledTimes(1); // fatal → not retried
  });

  it('classifies an embedding count mismatch as retryable', async () => {
    const g = new MistralModelGateway({ apiKey: 'test' });
    vi.spyOn(clientOf(g).embeddings, 'create').mockResolvedValue({ data: [] }); // 0 for 1 input
    await expect(g.embed(['only-one'])).rejects.toMatchObject({ retryable: true });
  });
});

describe('model-gateway seam — tier selection + structured validation', () => {
  it('selects the pipeline vs answer model per task (decision 0007 r3)', async () => {
    const g = new MistralModelGateway({ apiKey: 'k', pipelineModel: 'PIPE', answerModel: 'ANS' });
    const spy = vi.spyOn(clientOf(g).chat, 'complete').mockResolvedValue(jsonResponse('{}'));

    await g.complete({ input: 'q' }); // default tier = answer
    await g.complete({ input: 'q', tier: 'pipeline' });
    await g.extractStructured(z.object({}).passthrough(), { system: 's', input: '{}' }); // default = pipeline
    await g.extractStructured(z.object({}).passthrough(), {
      system: 's',
      input: '{}',
      tier: 'answer',
    });

    const models = spy.mock.calls.map((c) => (c[0] as { model: string }).model);
    expect(models).toEqual(['ANS', 'PIPE', 'PIPE', 'ANS']);
  });

  it('rejects malformed structured output as fatal after one corrective retry', async () => {
    const g = new MistralModelGateway({ apiKey: 'k' });
    const spy = vi
      .spyOn(clientOf(g).chat, 'complete')
      .mockResolvedValue(jsonResponse('{"wrong":1}')); // never satisfies {needed: string}
    await expect(
      g.extractStructured(z.object({ needed: z.string() }), { system: 's', input: 'x' }),
    ).rejects.toMatchObject({ retryable: false });
    expect(spy).toHaveBeenCalledTimes(2); // one corrective retry, then fatal
  });

  it('rejects non-JSON output as fatal, no retry', async () => {
    const g = new MistralModelGateway({ apiKey: 'k' });
    const spy = vi
      .spyOn(clientOf(g).chat, 'complete')
      .mockResolvedValue(jsonResponse('not json at all'));
    await expect(g.extractStructured(z.object({}), { system: 's', input: 'x' })).rejects.toThrow(
      /non-JSON/i,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // Live-optional: a real round-trip only when a key is present.
  it.skipIf(!process.env.MISTRAL_API_KEY)('live: embed returns a vector', async () => {
    const g = new MistralModelGateway({ apiKey: process.env.MISTRAL_API_KEY! });
    const [vec] = await g.embed(['hello world']);
    expect(vec.length).toBeGreaterThan(0);
  });
});

describe('model-gateway seam — prompt registry (integration)', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await startTestDatabase();
  });
  afterAll(async () => {
    await tdb.stop();
  });

  it('loads a versioned prompt and pins its version format', async () => {
    const prompt = await loadPrompt('task_closure', 'v0001');
    expect(prompt.family).toBe('task_closure');
    expect(prompt.version).toBe('v0001');
    expect(prompt.contentHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(loadPrompt('task_closure', 'v1')).rejects.toThrow(/must look like v0001/);
  });

  it('records a version once and refuses a changed body (immutability)', async () => {
    const prompt = await loadPrompt('task_closure', 'v0001');
    await recordPromptVersion(tdb.db, prompt); // first insert
    await recordPromptVersion(tdb.db, prompt); // idempotent no-op
    const tampered = {
      ...prompt,
      content: `${prompt.content} EDITED`,
      contentHash: 'f'.repeat(64),
    };
    await expect(recordPromptVersion(tdb.db, tampered)).rejects.toThrow(/immutable/i);
  });
});

// ── Architecture: only the gateway imports the Mistral client ─────────────────
const SRC_ROOT = path.resolve(__dirname, '..');
function sources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) sources(full, acc);
    else if (e.endsWith('.ts') && !e.endsWith('.spec.ts')) acc.push(full);
  }
  return acc;
}

describe('model-gateway seam — architecture', () => {
  it('no module outside model-gateway imports the Mistral client', () => {
    const offenders = sources(SRC_ROOT)
      .filter((f) => !f.includes(`${path.sep}model-gateway${path.sep}`))
      .filter((f) => /@mistralai/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(SRC_ROOT, f))).toEqual([]);
  });
});
