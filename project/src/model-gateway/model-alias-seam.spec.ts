import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleModelGateway } from './openai.gateway';

/**
 * The single translation seam (hosted provisioning, task A).
 *
 * A provider row may carry a served-name to upstream-identifier map, and the
 * plan's rule is absolute: translation happens at EXACTLY ONE place, where the
 * OpenAI-compatible adapter writes the outgoing request's `model` field. A
 * second translation site is how an upstream name eventually leaks into a
 * configuration id, a report, a log or a page, so the seam is pinned two ways:
 *
 * 1. Structurally: across the whole server and SPA source, the alias map is
 *    DEREFERENCED (indexed by a model name) in exactly one function of
 *    `openai.gateway.ts`. Everywhere else the map may only be carried whole
 *    or have its keys listed, which is discovery, not translation.
 * 2. Behaviourally: through a stubbed wire, every request an aliased adapter
 *    makes carries the upstream identifier in its `model` field, while every
 *    name the adapter REPORTS (embeddingModelId, errors) stays the served
 *    name, and an alias-free adapter is byte-identical.
 */

const SRC = path.resolve(__dirname, '..');
const WEB = path.resolve(__dirname, '..', '..', 'web', 'src');
const SHARED = path.resolve(__dirname, '..', '..', 'shared', 'src');

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe('model_alias_seam: served names translate to upstream identifiers in exactly one place', () => {
  it('the_alias_map_is_dereferenced_only_in_the_adapter', () => {
    const dereference = /modelAliases\??\.?\[/;
    const offenders: string[] = [];
    for (const root of [SRC, WEB, SHARED]) {
      for (const file of sourceFiles(root)) {
        if (file === __filename) continue;
        if (!dereference.test(readFileSync(file, 'utf8'))) continue;
        offenders.push(path.relative(path.resolve(SRC, '..'), file));
      }
    }
    expect(offenders).toEqual(['src/model-gateway/openai.gateway.ts']);

    // Inside the adapter: one dereference, inside the one named seam method.
    const adapter = readFileSync(path.join(SRC, 'model-gateway', 'openai.gateway.ts'), 'utf8');
    const sites = adapter.match(/modelAliases\??\.?\[/g) ?? [];
    expect(sites).toHaveLength(1);
    const seam = adapter.slice(adapter.indexOf('private upstreamModelId'));
    expect(seam.slice(0, seam.indexOf('}'))).toContain('this.modelAliases?.[model]');
  });

  it('the_comparison_helper_stays_a_comparison', () => {
    // `upstreamIdentityOf` reads map values to COMPARE two maps for the
    // embeddings geometry rule; it must never grow request-building callers.
    const callers = sourceFiles(SRC)
      .filter((file) => !file.endsWith('.spec.ts'))
      .filter((file) => readFileSync(file, 'utf8').includes('upstreamIdentityOf'))
      .map((file) => path.relative(SRC, file))
      .sort();
    expect(callers).toEqual([
      'providers/domain/managed-config.ts',
      'providers/managed-reconcile.ts',
    ]);
  });

  it('no_other_adapter_accepts_an_alias_map', () => {
    for (const file of ['mistral.gateway.ts', 'anthropic.gateway.ts']) {
      const text = readFileSync(path.join(SRC, 'model-gateway', file), 'utf8');
      expect(text, `${file} must not grow an alias path`).not.toContain('modelAliases');
    }
  });
});

describe('model_alias_seam: the wire carries the upstream identifier, everything else the served name', () => {
  const aliases = { 'served-answer': 'upstream-answer-9x', 'served-embed': 'upstream-embed-3e' };

  function adapterWith(map?: Readonly<Record<string, string>>): OpenAiCompatibleModelGateway {
    return new OpenAiCompatibleModelGateway({
      apiKey: 'k',
      baseUrl: 'http://stub.invalid/v1',
      pipelineModel: 'served-answer',
      answerModel: 'served-answer',
      embedModel: 'served-embed',
      visionModel: 'served-answer',
      ...(map ? { modelAliases: map } : {}),
    });
  }

  /** Captures each outgoing body; answers the OpenAI shape for chat + embeddings. */
  function stubWire(): { bodies: { url: string; model: unknown }[] } {
    const bodies: { url: string; model: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { model?: unknown };
        bodies.push({ url: String(url), model: body.model });
        const payload = String(url).includes('/embeddings')
          ? { data: [{ embedding: [0.1, 0.2] }] }
          : { choices: [{ message: { content: 'ok' } }] };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return { bodies };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('every_call_shape_translates_at_the_wire', async () => {
    const wire = stubWire();
    const adapter = adapterWith(aliases);
    await adapter.complete({ input: 'q', tier: 'answer' });
    await adapter.embed(['text']);
    await adapter.describeImage({
      input: 'read',
      image: { bytes: Buffer.from([1]), mediaType: 'image/png' },
    });
    expect(wire.bodies.map((entry) => entry.model)).toEqual([
      'upstream-answer-9x',
      'upstream-embed-3e',
      'upstream-answer-9x',
    ]);
    // What the adapter REPORTS stays the served name: the embeddings model id
    // feeds the vector index state and the configuration identity.
    expect(adapter.embeddingModelId()).toBe('served-embed');
    // The one sanctioned in-process exception: per-embedding-model CALIBRATION
    // is keyed by the geometry actually embedding, so the threshold tables see
    // the upstream identity while every message carries the served name.
    expect(adapter.embeddingGeometryId()).toBe('upstream-embed-3e');
    const serialized = JSON.stringify(wire.bodies);
    expect(serialized).not.toContain('served-answer');
  });

  it('an_alias_free_adapter_is_byte_identical', async () => {
    const wire = stubWire();
    const adapter = adapterWith();
    await adapter.complete({ input: 'q', tier: 'answer' });
    expect(wire.bodies[0]!.model).toBe('served-answer');
  });
});
