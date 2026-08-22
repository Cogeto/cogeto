import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createModelGateway, SELF_HOSTED_TIMEOUT_DEFAULTS_MS } from '../../model-gateway/index';
import { resolveFromRecords } from './resolve';
import { sealSecret } from '../../infrastructure/index';
import type { ProviderRecordWithSecret } from '../persistence/provider-store';
import type { ModelAnswerOptionRow, ModelAssignmentRow } from '../persistence/tables';

/**
 * Records to the running configuration (V2.4 item 7.1).
 *
 * The property that matters most here is the one the environment shape could
 * not express: **several providers of the same type**. Under `.env` there was
 * one base URL and one key per provider id, so a hosted OpenAI key beside a
 * llama.cpp proxy was unrepresentable. Both are provider id `openai`, and they
 * must not share an endpoint or a bearer token.
 */

const provider = (
  over: Partial<ProviderRecordWithSecret> & { id: string; type: string },
): ProviderRecordWithSecret => ({
  label: over.id,
  baseUrl: null,
  apiKeySecret: null,
  hasApiKey: false,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  ...over,
});

const assign = (tier: string, providerId: string, model: string): ModelAssignmentRow =>
  ({ tier, providerId, model, updatedAt: new Date(), updatedBy: null }) as ModelAssignmentRow;

const base = {
  version: 7,
  masterKey: null as Buffer | null,
  redacted: false,
  reasoningHeadroom: 4,
  timeoutsMs: SELF_HOSTED_TIMEOUT_DEFAULTS_MS,
  answerOptions: [] as ModelAnswerOptionRow[],
};

describe('resolve: stored records become the running configuration', () => {
  it('two_providers_one_type: each tier keeps its own endpoint and credential', () => {
    const masterKey = randomBytes(32);
    const resolved = resolveFromRecords({
      ...base,
      masterKey,
      providers: [
        provider({
          id: 'hosted',
          label: 'OpenAI',
          type: 'openai',
          apiKeySecret: sealSecret(masterKey, 'sk-hosted'),
          hasApiKey: true,
        }),
        provider({
          id: 'mine',
          label: 'Workshop GPU',
          type: 'self_hosted',
          baseUrl: 'http://host.docker.internal:9000/v1',
        }),
      ],
      assignments: [
        assign('pipeline', 'mine', 'test-model-a'),
        assign('answer', 'hosted', 'gpt-4o'),
        assign('embeddings', 'mine', 'bge-m3'),
      ],
    });

    expect(resolved.configured).toBe(true);
    expect(resolved.tiers.answer.endpoint).toMatchObject({
      id: 'hosted',
      apiKey: 'sk-hosted',
      selfHosted: false,
    });
    expect(resolved.tiers.pipeline.endpoint).toMatchObject({
      id: 'mine',
      baseUrl: 'http://host.docker.internal:9000/v1',
      selfHosted: true,
    });
    // Same provider id, two endpoints, two credentials: the whole point.
    expect(resolved.tiers.pipeline.provider).toBe('openai');
    expect(resolved.tiers.answer.provider).toBe('openai');
    expect(resolved.tiers.pipeline.endpoint!.apiKey).not.toBe(
      resolved.tiers.answer.endpoint!.apiKey,
    );
    // And the factory builds a distinct adapter per endpoint rather than
    // reusing one and sending the hosted key to the workshop machine.
    expect(() => createModelGateway({ providers: resolved })).not.toThrow();
  });

  it('adds_the_v1_suffix_a_pasted_endpoint_usually_lacks', () => {
    const resolved = resolveFromRecords({
      ...base,
      providers: [provider({ id: 'mine', type: 'self_hosted', baseUrl: 'http://gpu.lan:9000/' })],
      assignments: [
        assign('pipeline', 'mine', 'a'),
        assign('answer', 'mine', 'a'),
        assign('embeddings', 'mine', 'e'),
      ],
    });
    expect(resolved.tiers.answer.endpoint!.baseUrl).toBe('http://gpu.lan:9000/v1');
  });

  it('incomplete_is_unconfigured, not a crash: an admin can still reach the page', () => {
    const resolved = resolveFromRecords({
      ...base,
      providers: [provider({ id: 'mine', type: 'self_hosted', baseUrl: 'http://gpu.lan:9000/v1' })],
      assignments: [assign('pipeline', 'mine', 'a')],
    });
    expect(resolved.configured).toBe(false);
    expect(resolved.id).toBe('unconfigured');
  });

  it('vision_unassigned_is_a_complete_answer', () => {
    const resolved = resolveFromRecords({
      ...base,
      providers: [provider({ id: 'mine', type: 'self_hosted', baseUrl: 'http://gpu.lan:9000/v1' })],
      assignments: [
        assign('pipeline', 'mine', 'a'),
        assign('answer', 'mine', 'a'),
        assign('embeddings', 'mine', 'e'),
      ],
    });
    expect(resolved.vision).toBeNull();
    expect(resolved.id).not.toContain('--vis-');
  });

  it('carries_the_version, which is what makes the gateway notice a change', () => {
    const resolved = resolveFromRecords({
      ...base,
      providers: [],
      assignments: [],
    });
    expect(resolved.version).toBe(7);
    expect(resolved.source).toBe('database');
  });

  it('an_unreadable_key_disqualifies_that_provider, and does not throw', () => {
    // A rotated or lost master key must NOT refuse the boot: an admin cannot
    // re-enter a key on a page an unstarted app does not serve. Model features
    // go off, the reason is reported, the interface stays reachable.
    const unreadable: { id: string; label: string; reason: string }[] = [];
    const resolved = resolveFromRecords({
      ...base,
      masterKey: randomBytes(32),
      onUnreadable: (provider) => unreadable.push(provider),
      providers: [
        provider({
          id: 'hosted',
          label: 'OpenAI',
          type: 'openai',
          // Sealed under a DIFFERENT master key.
          apiKeySecret: sealSecret(randomBytes(32), 'sk-hosted'),
          hasApiKey: true,
        }),
      ],
      assignments: [
        assign('pipeline', 'hosted', 'gpt-4o-mini'),
        assign('answer', 'hosted', 'gpt-4o'),
        assign('embeddings', 'hosted', 'text-embedding-3-small'),
      ],
    });
    expect(resolved.configured).toBe(false);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]!.label).toBe('OpenAI');
    // The reason names the cause and the only fix, and carries no key material.
    expect(unreadable[0]!.reason).toMatch(/master key has changed/);
    expect(unreadable[0]!.reason).not.toContain('sk-hosted');
  });

  it('a_hosted_provider_with_no_key_leaves_its_tier_unresolved, never keyless', () => {
    const resolved = resolveFromRecords({
      ...base,
      providers: [provider({ id: 'hosted', type: 'openai' })],
      assignments: [
        assign('pipeline', 'hosted', 'gpt-4o-mini'),
        assign('answer', 'hosted', 'gpt-4o'),
        assign('embeddings', 'hosted', 'text-embedding-3-small'),
      ],
    });
    expect(resolved.configured).toBe(false);
  });
});
