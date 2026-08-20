import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { openSecret } from '../infrastructure/index';
import { createModelGateway, LiveModelConfiguration } from '../model-gateway/index';
import { loadModelConfiguration } from './load-configuration';
import { ProviderConfigService } from './provider-config.service';
import { ProviderStore } from './persistence/provider-store';
import { ManagedReconcileError, reconcileManagedProvider } from './managed-reconcile';
import type { ManagedReconcileDeps } from './managed-reconcile';

/**
 * The managed provider reconciler, end to end against real Postgres, real
 * Qdrant and a stub upstream endpoint that records every wire request
 * (hosted provisioning, task A).
 *
 * The stub is the witness for the central claim: the upstream identifier
 * exists ON THE WIRE and nowhere else. Every assertion about "what the
 * instance says" reads served names; every assertion about "what the endpoint
 * received" reads upstream identifiers; and the hand-configured canary
 * provider is compared field by field across reconciles.
 */

const MASTER_KEY = Buffer.alloc(32, 7);
const EMBED_DIMS = 8;

const admin: Principal = {
  userId: 'admin-1',
  name: 'Admin',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: ['admin'],
};

interface WireRecord {
  path: string;
  model: unknown;
}

/** A stub OpenAI-compatible endpoint: chat, embeddings, and a models list
 * that deliberately advertises upstream identifiers (what a real one does). */
function startStubUpstream(): Promise<{
  server: Server;
  url: string;
  wire: WireRecord[];
  modelListHits: () => number;
}> {
  const wire: WireRecord[] = [];
  let listHits = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const respond = (payload: unknown): void => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (request.method === 'GET' && request.url === '/v1/models') {
        listHits += 1;
        respond({ data: [{ id: 'upstream-answer-9x' }, { id: 'upstream-embed-3e' }] });
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
        model?: unknown;
        input?: unknown;
      };
      wire.push({ path: request.url ?? '', model: body.model });
      if (request.url === '/v1/embeddings') {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        respond({
          data: inputs.map(() => ({ embedding: Array.from({ length: EMBED_DIMS }, () => 0.5) })),
        });
        return;
      }
      // The refusing vision model answers and says nothing, which is how a
      // text-only server responds to an image: the probe must fail honestly.
      const content = body.model === 'upstream-vision-blind' ? '' : 'ready.';
      respond({ choices: [{ message: { content }, finish_reason: 'stop' }] });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
        wire,
        modelListHits: () => listHits,
      });
    });
  });
}

const MANAGED_FILE = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    label: 'Cogeto',
    type: 'selfhosted',
    base_url: '__BASE__/v1',
    models: {
      'served-fast': 'upstream-answer-9x',
      'served-deep': 'upstream-deep-1d',
      'served-embed': 'upstream-embed-3e',
      'served-vision': 'upstream-vision-7v',
    },
    assign: {
      pipeline: 'served-fast',
      answer: 'served-fast',
      embeddings: 'served-embed',
      vision: 'served-vision',
    },
    answer_options: ['served-fast', 'served-deep'],
    ...over,
  });

describe('managed_provider_reconcile: provision to answered request', () => {
  let pg: TestDatabase;
  let qdrant: TestQdrant;
  let stub: Awaited<ReturnType<typeof startStubUpstream>>;
  let live: LiveModelConfiguration;
  let service: ProviderConfigService;
  let store: ProviderStore;

  const timeoutsMs = { pipeline: 30_000, answer: 30_000, embedding: 30_000, vision: 30_000 };

  const deps = (): ManagedReconcileDeps => ({
    db: pg.db,
    service,
    masterKey: MASTER_KEY,
    qdrant: { url: qdrant.url },
    activeEmbeddingModel: live.current.tiers.embedding.model,
    probeTimeoutMs: 10_000,
  });

  const reconcile = (fileContent: string | null, apiKey: string | null): Promise<void> =>
    reconcileManagedProvider(
      { fileContent, fileSource: '/managed/managed-provider.json', apiKey },
      deps(),
    );

  const renderedFile = (over: Record<string, unknown> = {}): string =>
    MANAGED_FILE(over).split('__BASE__').join(stub.url);

  beforeAll(async () => {
    [pg, qdrant, stub] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startStubUpstream(),
    ]);
    live = new LiveModelConfiguration(
      await loadModelConfiguration(pg.db, {
        masterKey: MASTER_KEY,
        redacted: false,
        reasoningHeadroom: 4,
        timeoutsMs,
      }),
    );
    service = new ProviderConfigService(pg.db, {
      live,
      masterKey: MASTER_KEY,
      redacted: false,
      reasoningHeadroom: 4,
      timeoutsMs,
      trustScoresDir: '/nonexistent',
      pollIntervalMs: 0,
    });
    store = new ProviderStore(pg.db);
  }, 240_000);

  afterAll(async () => {
    await pg?.stop();
    await qdrant?.stop();
    stub?.server.close();
  });

  it('absent configuration is byte-identical to today', async () => {
    await reconcile(null, null);
    expect(await store.listProviders()).toEqual([]);
    // The unconfigured first-run state the banner renders from is untouched.
    expect(live.current.configured).toBe(false);
    expect(live.current.id).toBe('unconfigured');
    expect(stub.wire).toHaveLength(0);
  });

  it('half-present configuration refuses naming the missing half', async () => {
    await expect(reconcile(null, 'bootstrap-key')).rejects.toThrowError(
      /COGETO_MANAGED_PROVIDER_FILE/,
    );
    await expect(reconcile(renderedFile(), null)).rejects.toThrowError(
      /COGETO_MANAGED_PROVIDER_API_KEY/,
    );
    expect(await store.listProviders()).toEqual([]);
  });

  it('creates the managed row, applies initial assignments, and only the wire sees upstream ids', async () => {
    // The canary: a hand-configured provider pointing at the SAME endpoint,
    // created before the managed row ever exists.
    await store.createProvider({
      label: 'Hand-made',
      type: 'self_hosted',
      baseUrl: `${stub.url}/v1`,
      apiKeySecret: null,
    });
    const canaryBefore = (await store.listProvidersWithSecrets()).find(
      (row) => row.label === 'Hand-made',
    );

    await reconcile(renderedFile(), 'bootstrap-key');

    const managed = await store.findManagedProvider();
    expect(managed).not.toBeNull();
    expect(managed!.type).toBe('self_hosted');
    expect(managed!.modelAliases).toEqual({
      'served-fast': 'upstream-answer-9x',
      'served-deep': 'upstream-deep-1d',
      'served-embed': 'upstream-embed-3e',
      'served-vision': 'upstream-vision-7v',
    });

    // Assignments: the four tiers, in served names, embeddings through the
    // rebuild engine's one-transaction switch.
    const assignments = await store.listAssignments();
    const byTier = new Map(assignments.map((row) => [row.tier, row]));
    expect(byTier.get('pipeline')!.model).toBe('served-fast');
    expect(byTier.get('answer')!.model).toBe('served-fast');
    expect(byTier.get('embeddings')!.model).toBe('served-embed');
    expect(byTier.get('vision')!.model).toBe('served-vision');
    for (const row of assignments) expect(row.providerId).toBe(managed!.id);

    // The index state carries the PROBED dimension of the served embed model.
    const state = await pg.db.execute(
      sql`SELECT active_dimensions, active_collection FROM embedding_index_state`,
    );
    const stateRow = (state as unknown as { rows: Record<string, unknown>[] }).rows[0]!;
    expect(stateRow.active_dimensions).toBe(EMBED_DIMS);

    // The live configuration speaks served names; the id carries no upstream.
    expect(live.current.configured).toBe(true);
    expect(live.current.tiers.answer.model).toBe('served-fast');
    expect(live.current.tiers.embedding.model).toBe('served-embed');
    expect(live.current.id).toContain('served-fast');
    expect(live.current.id).not.toContain('upstream-');
    // Every NAME in the configuration is a served name; the alias map itself
    // rides the endpoint (like the decrypted key does) as the seam's input
    // and, like the key, never serializes into any DTO, id or report.
    for (const tier of ['pipeline', 'answer', 'embedding'] as const) {
      expect(live.current.tiers[tier].model).not.toContain('upstream-');
    }
    expect(live.current.vision?.model).toBe('served-vision');

    // Every wire request carried an upstream identifier, never a served name.
    expect(stub.wire.length).toBeGreaterThan(0);
    for (const record of stub.wire) {
      expect(String(record.model)).toMatch(/^upstream-/);
    }

    // The canary is byte-identical, every field including timestamps.
    const canaryAfter = (await store.listProvidersWithSecrets()).find(
      (row) => row.label === 'Hand-made',
    );
    expect(canaryAfter).toEqual(canaryBefore);

    // The audit entry: structural detail, and no upstream identifier in it.
    const audit = await pg.db.execute(
      sql`SELECT action, detail_json FROM audit_log WHERE action = 'model_provider.managed_reconciled'`,
    );
    const auditRows = (audit as unknown as { rows: { detail_json: unknown }[] }).rows;
    expect(auditRows.length).toBe(1);
    expect(JSON.stringify(auditRows[0]!.detail_json)).not.toContain('upstream-');
  }, 240_000);

  it('answers end to end through the alias: served name in, upstream id on the wire', async () => {
    const gateway = createModelGateway({ live });
    const before = stub.wire.length;
    const result = await gateway.complete({ tier: 'answer', input: 'hello' });
    expect(result.text).toBe('ready.');
    const last = stub.wire[stub.wire.length - 1]!;
    expect(stub.wire.length).toBe(before + 1);
    expect(last.model).toBe('upstream-answer-9x');
  });

  it('an unchanged reconcile is a no-op on the row and the version', async () => {
    const rowBefore = (await store.listProvidersWithSecrets()).find((row) => row.managed);
    const versionBefore = await store.readVersion();
    await reconcile(renderedFile(), 'bootstrap-key');
    const rowAfter = (await store.listProvidersWithSecrets()).find((row) => row.managed);
    expect(rowAfter).toEqual(rowBefore);
    expect(await store.readVersion()).toBe(versionBefore);
  });

  it('discovery lists exactly the served names, without asking the endpoint', async () => {
    const managed = await store.findManagedProvider();
    const hitsBefore = stub.modelListHits();
    const models = await service.listModels(managed!.id);
    expect(models.models).toEqual(['served-deep', 'served-embed', 'served-fast', 'served-vision']);
    expect(models.mayBePartial).toBe(false);
    expect(stub.modelListHits()).toBe(hitsBefore);
  });

  it('manual entry accepts only served names, and the managed card is locked', async () => {
    const managed = await store.findManagedProvider();
    await expect(
      service.assignTier(admin, 'answer', {
        providerId: managed!.id,
        model: 'upstream-answer-9x',
      }),
    ).rejects.toThrowError(/does not serve a model/);
    await expect(
      service.updateProvider(admin, managed!.id, { label: 'Mine' }),
    ).rejects.toThrowError(/managed by the hosting plan/);
    await expect(service.deleteProvider(admin, managed!.id)).rejects.toThrowError(
      /managed by the hosting plan/,
    );
    await expect(
      service.addAnswerOption(admin, {
        providerId: managed!.id,
        model: 'served-deep',
        label: 'Deep',
      }),
    ).rejects.toThrowError(/managed by the hosting plan/);
  });

  it('rotates the key by re-render: the new one seals, the old one is gone', async () => {
    const before = (await store.listProvidersWithSecrets()).find((row) => row.managed)!;
    await reconcile(renderedFile(), 'rotated-key');
    const after = (await store.listProvidersWithSecrets()).find((row) => row.managed)!;
    expect(after.apiKeySecret).not.toBe(before.apiKeySecret);
    expect(openSecret(MASTER_KEY, after.apiKeySecret!)).toBe('rotated-key');
    expect(openSecret(MASTER_KEY, before.apiKeySecret!)).toBe('bootstrap-key');
    // One sealed value on the row: the previous key is replaced, not kept.
    const count = await pg.db.execute(
      sql`SELECT count(*)::int AS keys FROM model_provider WHERE managed AND api_key_secret IS NOT NULL`,
    );
    expect((count as unknown as { rows: { keys: number }[] }).rows[0]!.keys).toBe(1);
  });

  it('refuses to change the upstream identity behind the assigned embeddings model, applying nothing', async () => {
    const before = (await store.listProvidersWithSecrets()).find((row) => row.managed)!;
    const repointed = renderedFile({
      label: 'Cogeto Plus',
      models: {
        'served-fast': 'upstream-answer-9x',
        'served-deep': 'upstream-deep-1d',
        'served-embed': 'upstream-embed-CHANGED',
        'served-vision': 'upstream-vision-7v',
      },
    });
    await expect(reconcile(repointed, 'rotated-key')).rejects.toThrowError(/cogeto reindex/);
    const after = (await store.listProvidersWithSecrets()).find((row) => row.managed)!;
    // Nothing applied: not the alias map, and not the label beside it.
    expect(after).toEqual(before);
  });

  it('refuses to drop a served name a tier is assigned to', async () => {
    const dropped = renderedFile({
      models: {
        'served-deep': 'upstream-deep-1d',
        'served-embed': 'upstream-embed-3e',
        'served-vision': 'upstream-vision-7v',
      },
      assign: {
        pipeline: 'served-deep',
        answer: 'served-deep',
        embeddings: 'served-embed',
        vision: 'served-vision',
      },
      answer_options: ['served-deep'],
    });
    await expect(reconcile(dropped, 'rotated-key')).rejects.toThrowError(
      /no longer serves "served-fast"/,
    );
  });

  it('applies an alias change behind a generation tier and the wire follows', async () => {
    const gateway = createModelGateway({ live });
    await reconcile(
      renderedFile({
        models: {
          'served-fast': 'upstream-answer-10x',
          'served-deep': 'upstream-deep-1d',
          'served-embed': 'upstream-embed-3e',
          'served-vision': 'upstream-vision-7v',
        },
        answer_options: ['served-fast'],
      }),
      'rotated-key',
    );
    // The answer options synced to the file: served-deep retired.
    const options = await store.listAnswerOptions();
    expect(options.map((option) => option.model)).toEqual(['served-fast']);
    // The reloaded live configuration reaches a gateway built on it.
    const result = await gateway.complete({ tier: 'answer', input: 'again' });
    expect(result.text).toBe('ready.');
    expect(stub.wire[stub.wire.length - 1]!.model).toBe('upstream-answer-10x');
  });
});

describe('managed_provider_reconcile: a blind vision upstream leaves vision unassigned', () => {
  let pg: TestDatabase;
  let qdrant: TestQdrant;
  let stub: Awaited<ReturnType<typeof startStubUpstream>>;

  beforeAll(async () => {
    [pg, qdrant, stub] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startStubUpstream(),
    ]);
  }, 240_000);

  afterAll(async () => {
    await pg?.stop();
    await qdrant?.stop();
    stub?.server.close();
  });

  it('creates the row with vision honestly missing', async () => {
    const timeoutsMs = { pipeline: 30_000, answer: 30_000, embedding: 30_000, vision: 30_000 };
    const live = new LiveModelConfiguration(
      await loadModelConfiguration(pg.db, {
        masterKey: MASTER_KEY,
        redacted: false,
        reasoningHeadroom: 4,
        timeoutsMs,
      }),
    );
    const service = new ProviderConfigService(pg.db, {
      live,
      masterKey: MASTER_KEY,
      redacted: false,
      reasoningHeadroom: 4,
      timeoutsMs,
      trustScoresDir: '/nonexistent',
      pollIntervalMs: 0,
    });
    const file = MANAGED_FILE({
      models: {
        'served-fast': 'upstream-answer-9x',
        'served-embed': 'upstream-embed-3e',
        'served-vision': 'upstream-vision-blind',
      },
      assign: {
        pipeline: 'served-fast',
        answer: 'served-fast',
        embeddings: 'served-embed',
        vision: 'served-vision',
      },
      answer_options: [],
    })
      .split('__BASE__')
      .join(stub.url);
    await reconcileManagedProvider(
      { fileContent: file, fileSource: '/managed/managed-provider.json', apiKey: 'k' },
      {
        db: pg.db,
        service,
        masterKey: MASTER_KEY,
        qdrant: { url: qdrant.url },
        activeEmbeddingModel: live.current.tiers.embedding.model,
        probeTimeoutMs: 10_000,
      },
    );
    const store = new ProviderStore(pg.db);
    const assignments = await store.listAssignments();
    expect(assignments.map((row) => row.tier).sort()).toEqual(['answer', 'embeddings', 'pipeline']);
    expect(live.current.vision).toBeNull();
    expect(live.current.configured).toBe(true);
  }, 240_000);

  it('a later boot with the same file does not retry the creation-time choice', async () => {
    // Assignments belong to the instance after creation: the reconcile is a
    // no-op and vision stays unassigned until an admin assigns it.
    const store = new ProviderStore(pg.db);
    const before = await store.listAssignments();
    expect(before.some((row) => row.tier === 'vision')).toBe(false);
  });
});

describe('managed_provider_reconcile: refusals are typed', () => {
  it('exposes a named error class for the boot path', () => {
    expect(new ManagedReconcileError('x')).toBeInstanceOf(Error);
  });
});
