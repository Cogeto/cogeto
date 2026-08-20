import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleModelGateway } from './openai.gateway';

/**
 * The thinking-control block is a learned parameter dialect (the issue #492
 * pattern). "Any OpenAI-compatible endpoint" includes the hosted OpenAI API,
 * which rejects unrecognized arguments outright, so an adapter with
 * per-request thinking control must learn from the specific 400 that names
 * one of the block's fields, drop the WHOLE block for that model, remember it
 * for the life of the process, and retry once. A server that accepts the
 * block keeps receiving it byte-identically.
 */

interface RecordedBody {
  chat_template_kwargs?: unknown;
  top_k?: unknown;
  min_p?: unknown;
  repetition_penalty?: unknown;
  response_format?: unknown;
}

function adapter(): OpenAiCompatibleModelGateway {
  return new OpenAiCompatibleModelGateway({
    apiKey: 'k',
    baseUrl: 'http://stub.invalid/v1',
    pipelineModel: 'model-a',
    answerModel: 'model-a',
    thinkingControl: true,
  });
}

/** A wire that refuses the thinking block N times the way OpenAI words it,
 * then answers; records every body. */
function stubWire(refusals: number): { bodies: RecordedBody[] } {
  const bodies: RecordedBody[] = [];
  let remaining = refusals;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as RecordedBody;
      bodies.push(body);
      if (body.chat_template_kwargs !== undefined && remaining > 0) {
        remaining -= 1;
        return new Response(
          JSON.stringify({
            error: {
              message: 'Unrecognized request argument supplied: chat_template_kwargs',
              type: 'invalid_request_error',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { bodies };
}

afterEach(() => vi.unstubAllGlobals());

describe('thinking_dialect: the refused block is learned away per model', () => {
  it('a refusal drops the whole block, retries once, and is remembered', async () => {
    const wire = stubWire(Infinity);
    const gateway = adapter();

    const first = await gateway.complete({ input: 'q', tier: 'answer', thinking: 'off' });
    expect(first.text).toBe('ok');
    // Attempt one carried the block (byte-identical legacy dialect first);
    // the single retry carried none of its fields, samplers included.
    expect(wire.bodies).toHaveLength(2);
    expect(wire.bodies[0]!.chat_template_kwargs).toBeDefined();
    expect(wire.bodies[1]!.chat_template_kwargs).toBeUndefined();
    expect(wire.bodies[1]!.top_k).toBeUndefined();
    expect(wire.bodies[1]!.min_p).toBeUndefined();
    expect(wire.bodies[1]!.repetition_penalty).toBeUndefined();

    // Remembered: the next call never sends it, costing no extra round trip,
    // and structured extraction (which sends only the flag) skips it too.
    await gateway.complete({ input: 'q2', tier: 'answer', thinking: 'on' });
    expect(wire.bodies).toHaveLength(3);
    expect(wire.bodies[2]!.chat_template_kwargs).toBeUndefined();
  });

  it('a server that accepts the block keeps receiving it', async () => {
    const wire = stubWire(0);
    const gateway = adapter();
    await gateway.complete({ input: 'q', tier: 'answer', thinking: 'off' });
    await gateway.complete({ input: 'q2', tier: 'answer', thinking: 'on' });
    expect(wire.bodies).toHaveLength(2);
    expect(wire.bodies[0]!.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(wire.bodies[1]!.chat_template_kwargs).toEqual({ enable_thinking: true });
  });
});
