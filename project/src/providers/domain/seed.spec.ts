import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveModelProviders } from '../../model-gateway/index';
import type { ResolvedModelProviders } from '../../model-gateway/index';
import { seedFromEnvironment } from './seed';
import { resolveFromRecords } from './resolve';
import { openSecret } from '../../infrastructure/index';
import type { ProviderStore } from '../persistence/provider-store';

/**
 * Seeding the environment into the database (V2.4 item 7.1).
 *
 * The overriding constraint of the whole item is asserted here: **no working
 * instance may break**. The reference deployment — one Caddy vhost in front of
 * two llama.cpp processes, reached from the containers at
 * `host.docker.internal:9000/v1`, no API key — must come across as one
 * Self-hosted provider and four assignments that resolve to the SAME bindings
 * and the SAME configuration id the environment produced.
 */

/** An in-memory ProviderStore: the six tables, as plain arrays. */
function fakeStore() {
  const providers: {
    id: string;
    label: string;
    type: string;
    baseUrl: string | null;
    apiKeySecret: string | null;
    hasApiKey: boolean;
    createdAt: Date;
  }[] = [];
  const assignments: {
    tier: string;
    providerId: string;
    model: string;
    updatedAt: Date;
    updatedBy: string | null;
  }[] = [];
  let seededAt: Date | null = null;
  let seedSource: string | null = null;
  let nextId = 1;
  const store = {
    async readState() {
      return { seededAt, seedSource, version: 1 };
    },
    async claimSeed(source: string) {
      if (seededAt) return false;
      seededAt = new Date();
      seedSource = source;
      return true;
    },
    async releaseSeed() {
      seededAt = null;
      seedSource = null;
    },
    async createProvider(input: {
      label: string;
      type: string;
      baseUrl: string | null;
      apiKeySecret: string | null;
    }) {
      const row = {
        id: `p${nextId++}`,
        ...input,
        hasApiKey: input.apiKeySecret !== null,
        createdAt: new Date(),
      };
      providers.push(row);
      return row;
    },
    async putAssignment(input: {
      tier: string;
      providerId: string;
      model: string;
      updatedBy: string | null;
    }) {
      assignments.push({ ...input, updatedAt: new Date() });
    },
    async listProvidersWithSecrets() {
      return providers;
    },
    async listAssignments() {
      return assignments;
    },
    async listAnswerOptions() {
      return [];
    },
  };
  return {
    store: store as unknown as ProviderStore,
    providers,
    assignments,
    source: () => seedSource,
  };
}

/** Exactly the reference deployment's `.env`, as the resolver reads it. */
const REFERENCE_ENV = {
  COGETO_PROVIDER_PIPELINE: 'openai',
  COGETO_PROVIDER_ANSWER: 'openai',
  COGETO_PROVIDER_EMBEDDINGS: 'openai',
  COGETO_PROVIDER_VISION: 'openai',
  COGETO_MODEL_PIPELINE: 'ff711',
  COGETO_MODEL_ANSWER: 'ff711',
  COGETO_MODEL_EMBEDDINGS: 'bge-m3',
  COGETO_MODEL_VISION: 'ff711',
  COGETO_OPENAI_BASE_URL: 'http://host.docker.internal:9000/v1',
} as NodeJS.ProcessEnv;

const resolveSeeded = (
  fake: ReturnType<typeof fakeStore>,
  masterKey: Buffer | null,
  environment: ResolvedModelProviders,
): Promise<ResolvedModelProviders> =>
  (async () =>
    resolveFromRecords({
      providers: await fake.store.listProvidersWithSecrets(),
      assignments: await fake.store.listAssignments(),
      answerOptions: [],
      version: 1,
      masterKey,
      redacted: environment.redacted,
      reasoningHeadroom: environment.reasoningHeadroom,
      timeoutsMs: environment.timeoutsMs,
    }))();

describe('seed: the environment comes across once, faithfully', () => {
  it('reference_deployment: one self-hosted provider and four assignments', async () => {
    const environment = resolveModelProviders(REFERENCE_ENV, { redacted: false });
    const fake = fakeStore();
    const result = await seedFromEnvironment(fake.store, environment, null);

    expect(result.seeded).toBe(true);
    expect(fake.providers).toHaveLength(1);
    expect(fake.providers[0]!.type).toBe('self_hosted');
    expect(fake.providers[0]!.baseUrl).toBe('http://host.docker.internal:9000/v1');
    // No key: the resolver synthesizes a placeholder for an endpoint that needs
    // no auth, and storing that in a column called api_key would be a lie.
    expect(fake.providers[0]!.apiKeySecret).toBeNull();
    expect(fake.assignments.map((row) => row.tier).sort()).toEqual([
      'answer',
      'embeddings',
      'pipeline',
      'vision',
    ]);
  });

  it('resolves_identically: same bindings, same configuration id, no tier reassigned', async () => {
    const environment = resolveModelProviders(REFERENCE_ENV, { redacted: false });
    const fake = fakeStore();
    await seedFromEnvironment(fake.store, environment, null);
    const seeded = await resolveSeeded(fake, null, environment);

    expect(seeded.configured).toBe(true);
    expect(seeded.id).toBe(environment.id);
    for (const tier of ['pipeline', 'answer', 'embedding'] as const) {
      expect(seeded.tiers[tier].provider).toBe(environment.tiers[tier].provider);
      expect(seeded.tiers[tier].model).toBe(environment.tiers[tier].model);
    }
    expect(seeded.vision).toMatchObject({ provider: 'openai', model: 'ff711' });
    // The endpoint the adapter will actually use, and the self-hosted posture
    // that decides per-tier timeouts and per-request thinking control.
    expect(seeded.tiers.answer.endpoint).toMatchObject({
      baseUrl: 'http://host.docker.internal:9000/v1',
      selfHosted: true,
    });
    expect(seeded.source).toBe('database');
  });

  it('exactly_once: a second start seeds nothing, even with providers deleted', async () => {
    const environment = resolveModelProviders(REFERENCE_ENV, { redacted: false });
    const fake = fakeStore();
    await seedFromEnvironment(fake.store, environment, null);
    fake.providers.length = 0;
    fake.assignments.length = 0;

    const second = await seedFromEnvironment(fake.store, environment, null);
    expect(second).toMatchObject({ seeded: false, reason: 'already_seeded' });
    expect(fake.providers).toHaveLength(0);
  });

  it('hosted_key_is_encrypted, and never stored in the clear', async () => {
    const masterKey = randomBytes(32);
    const environment = resolveModelProviders(
      { COGETO_MISTRAL_API_KEY: 'sk-mistral-secret' } as NodeJS.ProcessEnv,
      { redacted: false },
    );
    const fake = fakeStore();
    await seedFromEnvironment(fake.store, environment, masterKey);

    const stored = fake.providers[0]!;
    expect(stored.type).toBe('mistral');
    expect(stored.apiKeySecret).not.toBeNull();
    expect(stored.apiKeySecret).not.toContain('sk-mistral-secret');
    expect(openSecret(masterKey, stored.apiKeySecret!)).toBe('sk-mistral-secret');
  });

  it('refuses_before_claiming: a key with no master key fails and leaves nothing seeded', async () => {
    const environment = resolveModelProviders(
      { COGETO_MISTRAL_API_KEY: 'sk-mistral-secret' } as NodeJS.ProcessEnv,
      { redacted: false },
    );
    const fake = fakeStore();
    await expect(seedFromEnvironment(fake.store, environment, null)).rejects.toThrow(
      /COGETO_MASTER_KEY/,
    );
    // Not claimed: the next start, with the key set, seeds normally.
    expect(fake.source()).toBeNull();
    expect(fake.providers).toHaveLength(0);
  });

  it('nothing_configured: an instance with no model configuration is marked seeded, not broken', async () => {
    const environment = resolveModelProviders({} as NodeJS.ProcessEnv, { redacted: false });
    expect(environment.configured).toBe(false);
    const fake = fakeStore();
    const result = await seedFromEnvironment(fake.store, environment, null);
    expect(result).toMatchObject({ seeded: true, providers: 0 });
    expect(fake.source()).toBe('unconfigured');
  });
});
