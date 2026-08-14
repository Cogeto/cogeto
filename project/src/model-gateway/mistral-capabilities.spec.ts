import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * The Mistral adapter's optional capabilities: vision (issue #570) and
 * reasoning (issue #573). Both had the same shape of defect, which is why they
 * are pinned in one file.
 *
 * Vision on the Mistral adapter (issue #570).
 *
 * The defect: `describeImage` was implemented in the OpenAI-compatible adapter
 * only, and the factory handed `visionModel` to that adapter alone. A Mistral
 * vision assignment therefore resolved, stored, and routed into an adapter
 * with no image path, where the base class answered "no vision tier is
 * configured for this instance" — a statement about the adapter that reads as
 * a statement about the instance, and sends an admin back to the page they
 * just used.
 *
 * The Mistral SDK is stubbed because the property under test is what we SEND:
 * the image has to leave as an `image_url` content chunk, or the model never
 * sees it.
 */

const chatComplete = vi.hoisted(() => vi.fn());
const chatStream = vi.hoisted(() => vi.fn());

vi.mock('@mistralai/mistralai', () => ({
  Mistral: class {
    chat = { complete: chatComplete, stream: chatStream };
    embeddings = { create: vi.fn() };
    models = { list: vi.fn() };
  },
}));

const { MistralModelGateway } = await import('./mistral.gateway');
const { ModelGatewayError } = await import('./errors');
const { classifyVisionFailure } = await import('./vision-failure');
type VisionUnavailableErrorType = import('./errors').VisionUnavailableError;
const { createModelGateway } = await import('./factory');
const { resolveEvalProvidersFromEnv, ModelProviderConfigError } = await import('./provider-config');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const request = {
  system: 'Transcribe the page.',
  input: 'What does this page say?',
  image: { bytes: PNG, mediaType: 'image/png' as const },
  maxTokens: 512,
};

/**
 * The rejection, flattened to plain strings.
 *
 * Deliberately not the Error itself: a classified vision failure carries the
 * upstream error as its `cause`, and handing that chain to a matcher makes the
 * runner report the ROOT cause as an uncaught error and fail a test whose
 * assertions all pass. What matters here is the reason and the wording, and
 * both are strings.
 */
async function rejection(promise: Promise<unknown>): Promise<{ reason: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const failure = error as VisionUnavailableErrorType;
    return { reason: String(failure.reason), message: failure.message };
  }
  throw new Error('expected the call to reject');
}

/** What an OpenAI-shaped endpoint answers when the model cannot take images. */
const refusedUpstream = Object.assign(new Error('this model does not support image input'), {
  statusCode: 400,
});

const answered = (text: string): unknown => ({
  choices: [{ message: { content: text } }],
  usage: { promptTokens: 11, completionTokens: 7 },
});

describe('mistral vision', () => {
  beforeEach(() => chatComplete.mockReset());

  it('sends the image as an image_url content chunk, deterministically', async () => {
    chatComplete.mockResolvedValue(answered('INVOICE 2026-114'));
    const gateway = new MistralModelGateway({
      apiKey: 'k',
      visionModel: 'mistral-medium-2508',
      // Chat temperature must not reach a transcription call.
      temperature: 0.7,
    });

    const result = await gateway.describeImage(request);

    expect(result.text).toBe('INVOICE 2026-114');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });

    const body = chatComplete.mock.calls[0]![0] as {
      model: string;
      temperature: number;
      maxTokens: number;
      messages: { role: string; content: unknown }[];
    };
    expect(body.model).toBe('mistral-medium-2508');
    // Reading a page is transcription, not generation.
    expect(body.temperature).toBe(0);
    expect(body.maxTokens).toBe(512);
    const user = body.messages.find((message) => message.role === 'user');
    expect(user?.content).toEqual([
      { type: 'text', text: 'What does this page say?' },
      { type: 'image_url', imageUrl: `data:image/png;base64,${PNG.toString('base64')}` },
    ]);
  });

  it('with no vision model it names the PROVIDER, not the instance', async () => {
    const gateway = new MistralModelGateway({ apiKey: 'k' });
    const error = await rejection(gateway.describeImage(request));
    expect(error.reason).toBe('not_configured');
    // The old message said "no vision tier is configured for this INSTANCE",
    // which was false and sent an admin back to the page they just used.
    expect(error.message).toMatch(/provider "mistral"/);
    expect(error.message).not.toMatch(/this instance/);
    expect(chatComplete).not.toHaveBeenCalled();
  });

  it('routes a refused image through the shared classifier, not the raw provider error', () => {
    // What the adapter must not do is leak a transport error: "mistral call
    // failed (HTTP 400)" sends an operator to check the network, and the
    // endpoint understood us perfectly and said no to the IMAGE.
    //
    // Asserted against the classifier directly rather than by making the
    // stubbed SDK throw: a classified failure carries the upstream error as
    // its `cause`, and provoking that chain through the mock makes the runner
    // report the root cause as an uncaught error and fail a test whose
    // assertions all pass. The adapter's own catch is one call to this
    // function (mistral.gateway.ts), and the wiring is what the cases above
    // and below cover.
    const upstream = new ModelGatewayError(
      'mistral call failed (HTTP 400): this model does not support image input',
      false,
      refusedUpstream,
    );
    const classified = classifyVisionFailure(upstream, {
      label: 'mistral',
      model: 'mistral-small-latest',
      endpoint: 'https://api.mistral.ai',
      localRuntime: false,
    });
    expect(classified.reason).toBe('image_rejected');
    expect(classified.message).toMatch(/refused image input/);
    expect(classified.message).toMatch(/not a vision model/);
  });

  it('an accepted image with no text back is unusable, not unconfigured', async () => {
    chatComplete.mockResolvedValue(answered('   '));
    const gateway = new MistralModelGateway({ apiKey: 'k', visionModel: 'mistral-medium-2508' });
    const error = await rejection(gateway.describeImage(request));
    expect(error.reason).toBe('unusable_response');
  });

  it('THE REGRESSION: a Mistral vision binding built through the factory can see', async () => {
    // This is the bug exactly. Before the fix the factory computed
    // `visionModel` and passed it to the openai and ollama cases only, so this
    // gateway threw `not_configured` from the base class on every page.
    chatComplete.mockResolvedValue(answered('page text'));
    const providers = resolveEvalProvidersFromEnv(
      {
        COGETO_MISTRAL_API_KEY: 'k',
        COGETO_PROVIDER_VISION: 'mistral',
        COGETO_MODEL_VISION: 'mistral-medium-2508',
      },
      { redacted: false },
    );
    expect(providers.vision).toEqual({ provider: 'mistral', model: 'mistral-medium-2508' });

    const gateway = createModelGateway({ providers });
    await expect(gateway.describeImage(request)).resolves.toMatchObject({ text: 'page text' });
    expect((chatComplete.mock.calls[0]![0] as { model: string }).model).toBe('mistral-medium-2508');
  });

  it('a provider whose adapter cannot see is refused at resolution, not at the first page', async () => {
    // The VISION_CAPABLE twin of the embeddings gate (issue #571). Anthropic's
    // models are multimodal; this adapter has no image path, and finding that
    // out three hours into an ingestion run is the defect.
    expect(() =>
      resolveEvalProvidersFromEnv(
        {
          COGETO_MISTRAL_API_KEY: 'k',
          COGETO_ANTHROPIC_API_KEY: 'a',
          COGETO_PROVIDER_VISION: 'anthropic',
          COGETO_MODEL_VISION: 'claude-sonnet-4',
        },
        { redacted: false },
      ),
    ).toThrowError(ModelProviderConfigError);
    expect(() =>
      resolveEvalProvidersFromEnv(
        {
          COGETO_MISTRAL_API_KEY: 'k',
          COGETO_ANTHROPIC_API_KEY: 'a',
          COGETO_PROVIDER_VISION: 'anthropic',
          COGETO_MODEL_VISION: 'claude-sonnet-4',
        },
        { redacted: false },
      ),
    ).toThrowError(/cannot read images.*COGETO_PROVIDER_VISION/s);
  });
});

/**
 * Reasoning on the Mistral adapter (issue #573).
 *
 * Thinking is a CHANNEL. The adapter yielded only `{ channel: 'text' }`, and
 * `complete` never set `reasoned`, so `probeReasoning` (which reads that flag)
 * reported the `reasoning` capability off for every Mistral binding whatever
 * the model, and the chat toggle had nothing to show. Mistral carries a
 * reasoning turn as a `ThinkChunk` in the message content, which the adapter's
 * text extractor dropped on the floor.
 */
describe('mistral reasoning', () => {
  beforeEach(() => {
    chatComplete.mockReset();
    chatStream.mockReset();
  });

  /** A Magistral-shaped reply: a thinking chunk, then the answer. */
  const deliberated = (thinking: string, answer: string): unknown => ({
    choices: [
      {
        finishReason: 'stop',
        message: {
          content: [
            { type: 'thinking', thinking: [{ type: 'text', text: thinking }] },
            { type: 'text', text: answer },
          ],
        },
      },
    ],
    usage: { promptTokens: 20, completionTokens: 40 },
  });

  it('reports that the model reasoned, which is what the capability probe reads', async () => {
    chatComplete.mockResolvedValue(deliberated('weighing the options', 'Zagreb.'));
    const gateway = new MistralModelGateway({
      apiKey: 'k',
      answerModel: 'magistral-medium-latest',
    });
    const result = await gateway.complete({ input: 'where?' });
    expect(result.reasoned).toBe(true);
    // And the deliberation is NOT in the answer: it is a channel, never
    // content, so it must not reach storage, citations or redaction.
    expect(result.text).toBe('Zagreb.');
    expect(result.text).not.toContain('weighing');
  });

  it('a model that does not deliberate is unchanged: no reasoned flag, same text', async () => {
    chatComplete.mockResolvedValue(answered('Zagreb.'));
    const gateway = new MistralModelGateway({ apiKey: 'k', answerModel: 'mistral-medium-latest' });
    const result = await gateway.complete({ input: 'where?' });
    expect(result.reasoned).toBeUndefined();
    expect(result.text).toBe('Zagreb.');
  });

  it('streams thinking on its own channel, ahead of the answer', async () => {
    chatStream.mockResolvedValue(
      (async function* () {
        yield {
          data: {
            choices: [
              {
                delta: {
                  content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'hmm' }] }],
                },
              },
            ],
          },
        };
        yield { data: { choices: [{ delta: { content: 'Zag' } }] } };
        yield { data: { choices: [{ delta: { content: 'reb.' } }] } };
      })(),
    );
    const gateway = new MistralModelGateway({
      apiKey: 'k',
      answerModel: 'magistral-medium-latest',
    });
    const deltas = [];
    for await (const delta of gateway.completeStream({ input: 'where?' })) deltas.push(delta);
    expect(deltas).toEqual([
      { channel: 'thinking', text: 'hmm' },
      { channel: 'text', text: 'Zag' },
      { channel: 'text', text: 'reb.' },
    ]);
  });

  it('applies the reasoning headroom only after a model has SHOWN it reasons', async () => {
    // Learned from the answer, never from the name: mistral-medium and
    // magistral-medium are one call apart and only the reply says which.
    chatComplete.mockResolvedValue(deliberated('thinking', 'answer'));
    const gateway = new MistralModelGateway({
      apiKey: 'k',
      answerModel: 'magistral-medium-latest',
      reasoningHeadroom: 4,
    });
    await gateway.complete({ input: 'first', maxTokens: 500 });
    expect((chatComplete.mock.calls[0]![0] as { maxTokens: number }).maxTokens).toBe(500);
    await gateway.complete({ input: 'second', maxTokens: 500 });
    expect((chatComplete.mock.calls[1]![0] as { maxTokens: number }).maxTokens).toBe(2000);
  });

  it('a budget spent entirely on thinking is named, not reported as an empty answer', async () => {
    chatComplete.mockResolvedValue({
      choices: [
        {
          finishReason: 'length',
          message: {
            content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'still thinking' }] }],
          },
        },
      ],
    });
    const gateway = new MistralModelGateway({
      apiKey: 'k',
      answerModel: 'magistral-medium-latest',
    });
    const error = await rejection(gateway.complete({ input: 'where?', maxTokens: 32 }));
    expect(error.message).toMatch(/reasoning/i);
  });
});

/**
 * ASKING for thinking (issue #577). Measured against the live API before this
 * was written: `magistral-small-latest` with no parameter returns a plain
 * string and 14 completion tokens, and `mistral-small-latest` with
 * `reasoning_effort: "high"` returns the think chunk and 445. #573 built the
 * receiving half; the chat toggle reached the adapter and was dropped.
 */
describe('mistral reasoning_effort', () => {
  beforeEach(() => {
    chatComplete.mockReset();
    chatStream.mockReset();
  });

  const body = (call: number): Record<string, unknown> =>
    chatComplete.mock.calls[call]![0] as Record<string, unknown>;

  it('asks for thinking when the caller wants it, and asks it off when not', async () => {
    chatComplete.mockResolvedValue(answered('Zagreb.'));
    const gateway = new MistralModelGateway({ apiKey: 'k', answerModel: 'mistral-small-latest' });
    await gateway.complete({ input: 'where?', thinking: 'on' });
    expect(body(0).reasoningEffort).toBe('high');
    await gateway.complete({ input: 'where?', thinking: 'off' });
    expect(body(1).reasoningEffort).toBe('none');
  });

  it('a caller with NO thinking mode pays for nothing: the field is absent', async () => {
    // Research synthesis, skills, email drafts and the provider probe all call
    // the answer tier without a mode. Thinking tokens are charged, so an
    // absent mode must stay absent rather than default to on.
    chatComplete.mockResolvedValue(answered('Zagreb.'));
    const gateway = new MistralModelGateway({ apiKey: 'k', answerModel: 'mistral-small-latest' });
    await gateway.complete({ input: 'where?' });
    expect(body(0)).not.toHaveProperty('reasoningEffort');
  });

  it('never asks structured extraction to think: it is temperature 0 in JSON mode', async () => {
    chatComplete.mockResolvedValue({ choices: [{ message: { content: '{"ok":true}' } }] });
    const gateway = new MistralModelGateway({ apiKey: 'k', pipelineModel: 'mistral-small-latest' });
    await gateway.extractStructured(z.object({ ok: z.boolean() }), {
      system: 'extract',
      input: 'anything',
    });
    expect(body(0)).not.toHaveProperty('reasoningEffort');
    expect(body(0).temperature).toBe(0);
  });

  it('a model that refuses the field answers anyway, and is not asked twice', async () => {
    // Losing every chat reply to a rejected optional parameter would be a far
    // worse failure than not thinking.
    let seen = 0;
    chatComplete.mockImplementation((request: Record<string, unknown>) => {
      seen += 1;
      if ('reasoningEffort' in request) {
        return Promise.reject(
          Object.assign(new Error('unsupported parameter: reasoning_effort'), { statusCode: 400 }),
        );
      }
      return Promise.resolve(answered('Zagreb.'));
    });
    const gateway = new MistralModelGateway({ apiKey: 'k', answerModel: 'mistral-tiny' });
    await expect(gateway.complete({ input: 'where?', thinking: 'on' })).resolves.toMatchObject({
      text: 'Zagreb.',
    });
    expect(seen).toBe(2); // asked, refused, retried without it
    // Learned: the next call does not spend a round trip rediscovering it.
    await gateway.complete({ input: 'again?', thinking: 'on' });
    expect(seen).toBe(3);
  });

  it('the stream asks too, so live chat is where thinking actually shows', async () => {
    chatStream.mockResolvedValue(
      (async function* () {
        yield { data: { choices: [{ delta: { content: 'Zagreb.' } }] } };
      })(),
    );
    const gateway = new MistralModelGateway({ apiKey: 'k', answerModel: 'mistral-small-latest' });
    for await (const _ of gateway.completeStream({ input: 'where?', thinking: 'on' })) void _;
    expect((chatStream.mock.calls[0]![0] as Record<string, unknown>).reasoningEffort).toBe('high');
  });
});
