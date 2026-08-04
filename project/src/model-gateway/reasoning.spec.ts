import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ModelGateway } from './model-gateway.service';
import { OpenAiCompatibleModelGateway } from './openai.gateway';
import { probeReasoning, REASONING_PROBE_MAX_TOKENS } from './reasoning-probe';
import { ReasoningExhaustedBudgetError, VisionUnavailableError } from './errors';
import type { ResolvedModelProviders } from './provider-config';

/**
 * Part B of reasoning support — unit surface
 *
 *   reasoning_detected      — a response carrying a separate reasoning field
 *     marks the model and reports the bare fact; the reasoning TEXT never
 *     appears anywhere in the result.
 *   reasoning_headroom      — maxTokens is multiplied for models that have
 *     reasoned, and ONLY for them; the vision path shares the multiplier.
 *   reasoning_honest_error  — empty answer + non-empty reasoning +
 *     finish_reason length is the named exhaustion error, never a generic
 *     "returned no text".
 *   reasoning_discarded     — extractStructured parses `content` only; a
 *     reasoning field full of valid JSON can never reach the schema.
 *   reasoning_byte_identical — a model that never reasoned produces requests
 *     and results byte-identical to the pre-reasoning adapter.
 *   reasoning_probe         — the boot/registry probe classifies configured,
 *     unconfigured, mixed, failed and exhausted cases honestly.
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

/** An OpenAI-shape chat response, optionally with a llama.cpp reasoning field. */
const chat = (
  content: string,
  options: { reasoning?: string; finish?: string; field?: string } = {},
): object => ({
  choices: [
    {
      message: {
        content,
        ...(options.reasoning !== undefined
          ? { [options.field ?? 'reasoning_content']: options.reasoning }
          : {}),
      },
      finish_reason: options.finish ?? 'stop',
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
});

const gateway = (): OpenAiCompatibleModelGateway =>
  new OpenAiCompatibleModelGateway({
    apiKey: 'ok',
    pipelineModel: 'PIPE',
    answerModel: 'ANS',
    embedModel: 'EMB',
    visionModel: 'ANS',
    temperature: 0,
  });

const png = Buffer.from([0x89, 0x50]);

describe('reasoning_detected', () => {
  it('a separate reasoning field is reported as a bare fact and its text goes nowhere', async () => {
    stubFetch(chat('OK.', { reasoning: 'Thinking Process: 1. Analyze the request…' }));
    const result = await gateway().complete({ input: 'Say OK.' });
    expect(result.text).toBe('OK.');
    expect(result.reasoned).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Thinking Process');
  });

  it('every reasoning field name providers use is recognized', async () => {
    for (const field of ['reasoning_content', 'reasoning', 'thinking']) {
      vi.unstubAllGlobals();
      stubFetch(chat('OK.', { reasoning: 'because…', field }));
      const result = await gateway().complete({ input: 'q' });
      expect(result.reasoned).toBe(true);
    }
  });

  it('a whitespace-only reasoning field does not count', async () => {
    stubFetch(chat('OK.', { reasoning: '  \n' }));
    const result = await gateway().complete({ input: 'q' });
    expect(result.reasoned).toBeUndefined();
  });
});

describe('reasoning_headroom', () => {
  it('multiplies maxTokens for a model that reasoned, and only for that model', async () => {
    const { calls } = stubFetch(
      chat('OK.', { reasoning: 'deliberation' }), // answer tier: ANS learns
      chat('again'), // second answer call
      chat('pipeline'), // pipeline tier: PIPE never reasoned
    );
    const g = gateway();
    await g.complete({ input: 'probe', maxTokens: 64 });
    expect(calls[0]!.body.max_tokens).toBe(64); // nothing known yet — untouched

    await g.complete({ input: 'q', maxTokens: 64 });
    expect(calls[1]!.body.max_tokens).toBe(256); // ANS reasoned → x4 (default)

    await g.complete({ input: 'q', maxTokens: 64, tier: 'pipeline' });
    expect(calls[2]!.body.max_tokens).toBe(64); // PIPE never did → untouched
  });

  it('the factor is configurable', async () => {
    const { calls } = stubFetch(chat('OK.', { reasoning: 'r' }), chat('OK.'));
    const g = new OpenAiCompatibleModelGateway({
      apiKey: 'ok',
      answerModel: 'ANS',
      reasoningHeadroom: 10,
    });
    await g.complete({ input: 'probe' });
    await g.complete({ input: 'q', maxTokens: 50 });
    expect(calls[1]!.body.max_tokens).toBe(500);
  });

  it('repairs the vision probe: describeImage 64 becomes 256 once the shared model reasoned', async () => {
    const { calls } = stubFetch(
      chat('OK.', { reasoning: 'deliberation' }), // text probe teaches ANS
      chat('a blue square', { reasoning: 'the image shows…' }),
    );
    const g = gateway(); // visionModel is ANS — the owner's exact shape
    await g.complete({ input: 'probe' });
    const seen = await g.describeImage({
      input: 'what is this?',
      image: { bytes: png, mediaType: 'image/png' },
      maxTokens: 64,
    });
    expect(calls[1]!.body.max_tokens).toBe(256);
    expect(seen.text).toBe('a blue square');
  });
});

describe('reasoning_honest_error', () => {
  it('complete: empty answer + reasoning + finish length is the named exhaustion error', async () => {
    stubFetch(chat('', { reasoning: 'Thinking Process: …', finish: 'length' }));
    await expect(gateway().complete({ input: 'q', maxTokens: 16 })).rejects.toThrow(
      ReasoningExhaustedBudgetError,
    );
    vi.unstubAllGlobals();
    stubFetch(chat('', { reasoning: 'Thinking…', finish: 'length' }));
    await expect(gateway().complete({ input: 'q', maxTokens: 16 })).rejects.toThrow(
      /entire output budget.*reasoning/,
    );
  });

  it('describeImage reports it as its own vision reason, not "returned no text"', async () => {
    stubFetch(chat('', { reasoning: 'Thinking…', finish: 'length' }));
    const attempt = gateway().describeImage({
      input: 'read this page',
      image: { bytes: png, mediaType: 'image/png' },
      maxTokens: 64,
    });
    await expect(attempt).rejects.toMatchObject({
      name: 'VisionUnavailableError',
      reason: 'reasoning_exhausted',
    });
    await expect(
      gateway().describeImage({ input: 'p', image: { bytes: png, mediaType: 'image/png' } }),
    ).rejects.toThrow(/output budget/);
  });

  it('an empty answer WITHOUT reasoning keeps the historical diagnosis', async () => {
    stubFetch(chat('', { finish: 'length' }));
    await expect(
      gateway().describeImage({ input: 'p', image: { bytes: png, mediaType: 'image/png' } }),
    ).rejects.toMatchObject({ reason: 'unusable_response' });
  });

  it('a finished (stop) empty answer beside reasoning is NOT the exhaustion error', async () => {
    stubFetch(chat('', { reasoning: 'hmm' }));
    const result = await gateway().complete({ input: 'q' });
    expect(result.text).toBe('');
  });
});

describe('reasoning_discarded', () => {
  const schema = z.object({ value: z.number() }).strict();

  it('extractStructured parses content only — reasoning JSON never reaches the schema', async () => {
    stubFetch(chat('{"value": 1}', { reasoning: '{"value": 999, "sneaky": true}' }));
    const parsed = await gateway().extractStructured(schema, { system: 's', input: 'i' });
    expect(parsed).toEqual({ value: 1 });
  });

  it('reasoning is never a fallback: empty content stays a non-JSON failure', async () => {
    stubFetch(chat('', { reasoning: '{"value": 2}' }));
    await expect(gateway().extractStructured(schema, { system: 's', input: 'i' })).rejects.toThrow(
      'model returned non-JSON output',
    );
  });

  it('an extraction exhausted by reasoning raises the named error, not a parse error', async () => {
    stubFetch(chat('', { reasoning: 'Thinking…', finish: 'length' }));
    await expect(gateway().extractStructured(schema, { system: 's', input: 'i' })).rejects.toThrow(
      ReasoningExhaustedBudgetError,
    );
  });
});

describe('reasoning_byte_identical', () => {
  it('a model that never reasoned sends exactly the historical request bodies', async () => {
    const { calls } = stubFetch(chat('plain'), chat('{"value": 1}'), chat('a page'));
    const g = gateway();
    await g.complete({ input: 'q', system: 's', maxTokens: 64 });
    expect(calls[0]!.body).toEqual({
      model: 'ANS',
      max_tokens: 64,
      temperature: 0,
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'q' },
      ],
    });

    await g.extractStructured(z.object({ value: z.number() }), { system: 's', input: 'i' });
    expect(calls[1]!.body).toEqual({
      model: 'PIPE',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'i' },
      ],
    });

    await g.describeImage({
      input: 'p',
      image: { bytes: png, mediaType: 'image/png' },
      maxTokens: 64,
    });
    expect(calls[2]!.body).toEqual({
      model: 'ANS',
      max_tokens: 64,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'p' },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
            },
          ],
        },
      ],
    });
  });

  it('and byte-identical results: no reasoned flag, empty text still returned not thrown', async () => {
    stubFetch(chat('hello'));
    const result = await gateway().complete({ input: 'q' });
    expect(result).toEqual({ text: 'hello', usage: { inputTokens: 11, outputTokens: 7 } });
    vi.unstubAllGlobals();
    stubFetch(chat('', { finish: 'length' }));
    const empty = await gateway().complete({ input: 'q', maxTokens: 4 });
    expect(empty).toEqual({ text: '', usage: { inputTokens: 11, outputTokens: 7 } });
  });
});

describe('reasoning_probe', () => {
  const providers = (
    tiers: Partial<ResolvedModelProviders['tiers']> = {},
  ): ResolvedModelProviders =>
    ({
      configured: true,
      reasoningHeadroom: 4,
      tiers: {
        pipeline: { provider: 'openai', model: 'ff711' },
        answer: { provider: 'openai', model: 'ff711' },
        embedding: { provider: 'mistral', model: 'mistral-embed' },
        ...tiers,
      },
    }) as unknown as ResolvedModelProviders;

  const fake = (
    complete: (request: { tier?: string }) => Promise<{ text: string; reasoned?: boolean }>,
  ) => ({ complete }) as unknown as ModelGateway;

  it('nothing to probe on an unconfigured gateway', async () => {
    const result = await probeReasoning(
      fake(() => Promise.reject(new Error('never called'))),
      { configured: false } as ResolvedModelProviders,
    );
    expect(result).toMatchObject({ reasoning: false, probed: false });
  });

  it('one call per DISTINCT binding; a reasoning field flips the capability on', async () => {
    const seen: (string | undefined)[] = [];
    const result = await probeReasoning(
      fake((request) => {
        seen.push(request.tier);
        return Promise.resolve({ text: 'OK.', reasoned: true });
      }),
      providers(),
    );
    expect(seen).toEqual(['pipeline']); // both tiers share ff711 → one probe
    expect(result.reasoning).toBe(true);
    expect(result.probed).toBe(true);
    expect(result.detail).toContain('openai/ff711');
    expect(result.detail).toContain('x4');
  });

  it('distinct bindings are probed separately; one reasoning binding is enough', async () => {
    const seen: (string | undefined)[] = [];
    const result = await probeReasoning(
      fake((request) => {
        seen.push(request.tier);
        return Promise.resolve(
          request.tier === 'answer' ? { text: 'OK.', reasoned: true } : { text: 'OK.' },
        );
      }),
      providers({ answer: { provider: 'openai', model: 'other' } }),
    );
    expect(seen).toEqual(['pipeline', 'answer']);
    expect(result.reasoning).toBe(true);
    expect(result.detail).toContain('openai/other');
  });

  it('no reasoning field anywhere is a plain, healthy off', async () => {
    const result = await probeReasoning(
      fake(() => Promise.resolve({ text: 'OK.' })),
      providers(),
    );
    expect(result).toMatchObject({ reasoning: false, probed: true });
    expect(result.error).toBeUndefined();
  });

  it('the exhaustion error IS a reasoning observation', async () => {
    const result = await probeReasoning(
      fake(() => Promise.reject(new ReasoningExhaustedBudgetError('ff711', 'openai', 16))),
      providers(),
    );
    expect(result.reasoning).toBe(true);
  });

  it('a failed probe reports off with the failure named, never a guess', async () => {
    const result = await probeReasoning(
      fake(() => Promise.reject(new Error('ECONNREFUSED'))),
      providers(),
    );
    expect(result).toMatchObject({ reasoning: false, probed: true });
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('a slow binding trips the probe deadline and names the variable to raise', async () => {
    const result = await probeReasoning(
      fake(() => new Promise((resolve) => setTimeout(() => resolve({ text: 'OK.' }), 100))),
      providers(),
      { timeoutMs: 10 },
    );
    expect(result.reasoning).toBe(false);
    expect(result.error).toContain('COGETO_REASONING_PROBE_TIMEOUT_MS');
  });

  it('probes with a bounded budget, not an open-ended call', async () => {
    let sentMax: number | undefined;
    await probeReasoning(
      fake((request) => {
        sentMax = (request as { maxTokens?: number }).maxTokens;
        return Promise.resolve({ text: 'OK.' });
      }),
      providers(),
    );
    expect(sentMax).toBe(REASONING_PROBE_MAX_TOKENS);
  });
});

describe('reasoning_probe_unreachable_error', () => {
  it('VisionUnavailableError from the vision path is untouched by this change', () => {
    const error = new VisionUnavailableError('reasoning_exhausted', 'spent it all thinking');
    expect(error.retryable).toBe(false);
    expect(error.reason).toBe('reasoning_exhausted');
  });
});

describe('reasoning_stream_channel', () => {
  const sse = (...events: object[]): Response =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const event of events) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  const delta = (fields: object): object => ({ choices: [{ delta: fields }] });

  it('yields thinking and text as labeled channels, in order, and arms headroom', async () => {
    const { calls } = stubFetch(
      sse(
        delta({ reasoning_content: 'Thinking about it. ' }),
        delta({ reasoning_content: 'Still thinking. ' }),
        delta({ content: 'OK' }),
        delta({ content: '.' }),
      ),
      chat('follow-up'),
    );
    const g = gateway();
    const seen: { channel: string; text: string }[] = [];
    for await (const d of g.completeStream({ input: 'q', maxTokens: 64 })) seen.push(d);
    expect(seen).toEqual([
      { channel: 'thinking', text: 'Thinking about it. ' },
      { channel: 'thinking', text: 'Still thinking. ' },
      { channel: 'text', text: 'OK' },
      { channel: 'text', text: '.' },
    ]);
    // A thinking delta marked the model: the NEXT capped call gets headroom.
    await g.complete({ input: 'q', maxTokens: 64 });
    expect(calls[1]!.body.max_tokens).toBe(256);
  });

  it('a non-reasoning stream yields text deltas only — the same bytes as ever', async () => {
    stubFetch(sse(delta({ content: 'plain ' }), delta({ content: 'answer' })));
    const seen: { channel: string; text: string }[] = [];
    for await (const d of gateway().completeStream({ input: 'q' })) seen.push(d);
    expect(seen).toEqual([
      { channel: 'text', text: 'plain ' },
      { channel: 'text', text: 'answer' },
    ]);
  });
});
