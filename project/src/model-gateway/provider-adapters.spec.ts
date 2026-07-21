import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { ModelGateway } from './model-gateway.service';
import type {
  CompletionRequest,
  CompletionResult,
  StructuredExtractionRequest,
} from './model-gateway.service';
import { OpenAiCompatibleModelGateway } from './openai.gateway';
import { AnthropicModelGateway } from './anthropic.gateway';
import { TierRoutedModelGateway } from './routed.gateway';
import { BudgetedModelGateway } from './budgeted.gateway';
import { RedactingModelGateway } from './redacting.gateway';
import { createModelGateway } from './factory';
import { resolveModelProviders } from './provider-config';
import { isRetryableStatus, stripJsonFence } from './provider';
import type { ModelUsageMeter } from '../infrastructure/index';

/**
 * Provider adapter contracts (decision 0040 rulings 1–4): mocked upstreams —
 * no network is ever touched. `fetch` is stubbed per test and restored.
 */

type FetchCall = { url: string; body: Record<string, unknown> };

function stubFetch(...responses: unknown[]): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
      const next = responses[Math.min(i++, responses.length - 1)];
      if (next instanceof Response) return next;
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const openaiChat = (content: string, usage = true): object => ({
  choices: [{ message: { content } }],
  ...(usage ? { usage: { prompt_tokens: 11, completion_tokens: 7 } } : {}),
});

const anthropicMessage = (text: string): object => ({
  content: [{ type: 'text', text }],
  usage: { input_tokens: 21, output_tokens: 9 },
});

describe('adapter_contract_openai', () => {
  const gateway = (): OpenAiCompatibleModelGateway =>
    new OpenAiCompatibleModelGateway({
      apiKey: 'ok',
      pipelineModel: 'PIPE',
      answerModel: 'ANS',
      embedModel: 'EMB',
      temperature: 0,
    });

  it('completes with tier→model mapping and normalized token usage', async () => {
    const { calls } = stubFetch(openaiChat('hello'));
    const result = await gateway().complete({ input: 'q', system: 's' });
    expect(result.text).toBe('hello');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.body.model).toBe('ANS'); // default tier = answer
    expect(calls[0]!.body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'q' },
    ]);
  });

  it('structured output: JSON mode, temperature 0, valid on first shot', async () => {
    const { calls } = stubFetch(openaiChat('{"needed":"yes"}'));
    const out = await gateway().extractStructured(z.object({ needed: z.string() }), {
      system: 's',
      input: 'x',
    });
    expect(out).toEqual({ needed: 'yes' });
    expect(calls[0]!.body.model).toBe('PIPE'); // default tier = pipeline
    expect(calls[0]!.body.temperature).toBe(0);
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' });
  });

  it('schema-invalid output is repaired with exactly one corrective retry', async () => {
    const { calls } = stubFetch(openaiChat('{"wrong":1}'), openaiChat('{"needed":"now"}'));
    const out = await gateway().extractStructured(z.object({ needed: z.string() }), {
      system: 's',
      input: 'x',
    });
    expect(out).toEqual({ needed: 'now' });
    expect(calls).toHaveLength(2);
    expect(String((calls[1]!.body.messages as { content: string }[])[1]!.content)).toMatch(
      /failed validation/,
    );
  });

  it('twice-invalid output is a fatal typed failure', async () => {
    const { calls } = stubFetch(openaiChat('{"wrong":1}'));
    await expect(
      gateway().extractStructured(z.object({ needed: z.string() }), { system: 's', input: 'x' }),
    ).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(2); // one corrective retry, then fatal
  });

  it('non-JSON output is fatal with no retry', async () => {
    const { calls } = stubFetch(openaiChat('not json at all'));
    await expect(
      gateway().extractStructured(z.object({}), { system: 's', input: 'x' }),
    ).rejects.toThrow(/non-JSON/i);
    expect(calls).toHaveLength(1);
  });

  it('classifies a provider 4xx as fatal (retryable=false), no retry', async () => {
    const { calls } = stubFetch(
      new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 }),
    );
    await expect(gateway().complete({ input: 'q' })).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(1);
  });

  it('classifies 429/5xx/network as retryable, 4xx as fatal (pure)', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(529)).toBe(true);
    expect(isRetryableStatus(undefined)).toBe(true); // network failure
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it('embeds against the configured model; a count mismatch is retryable', async () => {
    const { calls } = stubFetch({ data: [{ embedding: [0.1, 0.2] }] });
    const [vec] = await gateway().embed(['one']);
    expect(vec).toEqual([0.1, 0.2]);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/embeddings');
    expect(calls[0]!.body.model).toBe('EMB');

    stubFetch({ data: [] });
    await expect(gateway().embed(['one'])).rejects.toMatchObject({ retryable: true });
  });

  it('a tier without a configured model is a typed fatal error', async () => {
    stubFetch(openaiChat('x'));
    const answerOnly = new OpenAiCompatibleModelGateway({ apiKey: 'k', answerModel: 'ANS' });
    await expect(
      answerOnly.extractStructured(z.object({}), { system: 's', input: 'x' }),
    ).rejects.toMatchObject({ retryable: false });
    expect(() => answerOnly.embeddingModelId()).toThrowError(/no embeddings model/);
  });

  it('honors a custom base URL (the Priority-4 doorway)', async () => {
    const { calls } = stubFetch(openaiChat('hi'));
    const local = new OpenAiCompatibleModelGateway({
      apiKey: 'k',
      baseUrl: 'http://ollama:11434/v1',
      answerModel: 'llama3',
    });
    await local.complete({ input: 'q' });
    expect(calls[0]!.url).toBe('http://ollama:11434/v1/chat/completions');
  });
});

describe('adapter_contract_anthropic', () => {
  const gateway = (): AnthropicModelGateway =>
    new AnthropicModelGateway({ apiKey: 'ak', pipelineModel: 'PIPE', answerModel: 'ANS' });

  it('completes via the Messages API with required max_tokens and NO sampling params', async () => {
    const { calls } = stubFetch(anthropicMessage('hello'));
    const result = await gateway().complete({ input: 'q', system: 's' });
    expect(result.text).toBe('hello');
    expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 9 });
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.body.model).toBe('ANS');
    expect(calls[0]!.body.max_tokens).toBe(8192); // required by the API — defaulted
    expect(calls[0]!.body.system).toBe('s');
    expect(calls[0]!.body).not.toHaveProperty('temperature'); // 0040 r1: rejected upstream
  });

  it('structured output: JSON-only instruction + fence strip + shared repair loop', async () => {
    const { calls } = stubFetch(anthropicMessage('```json\n{"needed":"yes"}\n```'));
    const out = await gateway().extractStructured(z.object({ needed: z.string() }), {
      system: 'extract',
      input: 'x',
    });
    expect(out).toEqual({ needed: 'yes' }); // fenced JSON still validates
    expect(calls[0]!.body.model).toBe('PIPE');
    expect(String(calls[0]!.body.system)).toMatch(/single valid JSON object only/);
  });

  it('malformed output is repaired once, then fatal', async () => {
    const { calls } = stubFetch(anthropicMessage('{"wrong":1}'));
    await expect(
      gateway().extractStructured(z.object({ needed: z.string() }), { system: 's', input: 'x' }),
    ).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(2);
  });

  it('classifies a provider 4xx as fatal, no retry', async () => {
    const { calls } = stubFetch(
      new Response(JSON.stringify({ error: { message: 'invalid_request' } }), { status: 400 }),
    );
    await expect(gateway().complete({ input: 'q' })).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(1);
  });

  it('embeddings are a declared-absent capability: typed fatal error', async () => {
    stubFetch(anthropicMessage('x'));
    await expect(gateway().embed()).rejects.toMatchObject({ retryable: false });
    expect(() => gateway().embeddingModelId()).toThrowError(/no embeddings API/);
  });

  it('stripJsonFence leaves bare JSON and prose untouched (pure)', () => {
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFence('not json')).toBe('not json');
  });
});

/** A recording fake used for routing + decorator-chain assertions. */
class FakeGateway extends ModelGateway {
  seen: string[] = [];
  constructor(private readonly name: string) {
    super();
  }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.seen.push(`complete:${request.tier ?? 'answer'}`);
    return { text: this.name, usage: { inputTokens: 100, outputTokens: 50 } };
  }
  async *completeStream(request: CompletionRequest): AsyncIterable<string> {
    this.seen.push(`stream:${request.tier ?? 'answer'}`);
    yield this.name;
  }
  async extractStructured<T>(
    schema: ZodType<T, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T> {
    this.seen.push(`structured:${request.tier ?? 'pipeline'}`);
    return schema.parse({});
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.seen.push('embed');
    return texts.map(() => [0]);
  }
  embeddingModelId(): string {
    return `${this.name}-embed`;
  }
}

describe('TierRoutedModelGateway — per-tier dispatch (0040 ruling 1)', () => {
  it('routes each call to its tier and embeddings to the embeddings binding', async () => {
    const pipe = new FakeGateway('pipe');
    const ans = new FakeGateway('ans');
    const emb = new FakeGateway('emb');
    const routed = new TierRoutedModelGateway({ pipeline: pipe, answer: ans, embedding: emb });

    await routed.complete({ input: 'q' }); // default answer
    await routed.complete({ input: 'q', tier: 'pipeline' });
    await routed.extractStructured(z.object({}).passthrough(), { system: 's', input: '{}' });
    for await (const _ of routed.completeStream({ input: 'q' })) void _;
    await routed.embed(['x']);

    expect(ans.seen).toEqual(['complete:answer', 'stream:answer']);
    expect(pipe.seen).toEqual(['complete:pipeline', 'structured:pipeline']);
    expect(emb.seen).toEqual(['embed']);
    expect(routed.embeddingModelId()).toBe('emb-embed');
  });
});

class FakeMeter implements ModelUsageMeter {
  records: { userId: string; tokens: number }[] = [];
  currentUserId(): string {
    return 'user-a';
  }
  hasBudget(): boolean {
    return true;
  }
  record(userId: string, tokens: number): void {
    this.records.push({ userId, tokens });
  }
}

const CONFIGS: Record<string, Record<string, string>> = {
  mistral: { COGETO_MISTRAL_API_KEY: 'k' },
  openai: { COGETO_PROVIDER_PRESET: 'openai-default', COGETO_OPENAI_API_KEY: 'k' },
  anthropic: {
    COGETO_PROVIDER_PRESET: 'anthropic-answer',
    COGETO_ANTHROPIC_API_KEY: 'k',
    COGETO_MISTRAL_API_KEY: 'k',
  },
};

describe('redaction_applies_all_providers / budget_applies_all_providers', () => {
  for (const [name, vars] of Object.entries(CONFIGS)) {
    it(`${name}: the factory chain is budget → redaction → provider (no bypass)`, () => {
      const providers = resolveModelProviders(vars as NodeJS.ProcessEnv, { redacted: true });
      const gateway = createModelGateway({
        providers,
        redaction: { enabled: true, url: 'http://redaction:8080' },
        usageMeter: new FakeMeter(),
      });
      // Outermost: the budget gate; inside it: redaction; inside that: the
      // provider (or the tier router for a mixed configuration). Every model
      // call flows through the same decorators regardless of provider.
      expect(gateway).toBeInstanceOf(BudgetedModelGateway);
      const redacting = (gateway as unknown as { inner: unknown }).inner;
      expect(redacting).toBeInstanceOf(RedactingModelGateway);
      const provider = (redacting as unknown as { inner: unknown }).inner;
      expect(provider).toBeInstanceOf(ModelGateway);
      expect(provider).not.toBeInstanceOf(RedactingModelGateway);
      expect(provider).not.toBeInstanceOf(BudgetedModelGateway);
      if (name === 'anthropic') {
        // Mixed configuration → the tier router carries the adapters.
        expect(provider).toBeInstanceOf(TierRoutedModelGateway);
      }
    });
  }

  it('the budget decorator charges provider-REPORTED usage when present (0040 r4)', async () => {
    const meter = new FakeMeter();
    const inner = new FakeGateway('any');
    const budgeted = new BudgetedModelGateway(inner, meter);
    await budgeted.complete({ input: 'question' });
    expect(meter.records).toEqual([{ userId: 'user-a', tokens: 150 }]); // 100 in + 50 out
  });
});
