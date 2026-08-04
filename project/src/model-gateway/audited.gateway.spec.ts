import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { ModelGateway } from './model-gateway.service';
import type { StreamDelta } from './model-gateway.service';
import type { CompletionRequest, StructuredExtractionRequest } from './model-gateway.service';
import { AuditedModelGateway } from './audited.gateway';
import { createModelGateway } from './factory';
import type { ModelEgressAudit, ModelEgressEntry } from '../infrastructure/index';

/**
 * Model egress is recorded, and what is recorded is metadata (V2.0 item 3.7).
 *
 * Two properties, and the second is the one that matters more: EVERY call
 * through the seam produces an entry, and NO entry carries the prompt, the
 * completion, or a fragment of either (AGENTS.md "No content in
 * `audit_log.detail_json`, ever").
 */

const SECRET_INPUT = 'Ivan approved the 40k transfer to Adriatic Foods on Tuesday';
const SECRET_OUTPUT = 'Marta signed the Atlas lease at 12 Ilica Street';

class RecordingGateway extends ModelGateway {
  async complete(_request: CompletionRequest) {
    return { text: SECRET_OUTPUT, usage: { inputTokens: 11, outputTokens: 7 } };
  }
  async *completeStream(_request: CompletionRequest): AsyncIterable<StreamDelta> {
    yield { channel: 'text', text: SECRET_OUTPUT.slice(0, 5) } as const;
    yield { channel: 'text', text: SECRET_OUTPUT.slice(5) } as const;
  }
  async extractStructured<T>(schema: ZodType<T, unknown>, _r: StructuredExtractionRequest) {
    return schema.parse({ claim: SECRET_OUTPUT });
  }
  async embed(texts: string[]) {
    return texts.map(() => [0, 1]);
  }
  embeddingModelId() {
    return 'test-embed';
  }
}

class ExplodingGateway extends RecordingGateway {
  override async complete(): Promise<never> {
    throw new TypeError('upstream said no at https://api.example/v1/chat');
  }
}

class CollectingAudit implements ModelEgressAudit {
  readonly entries: ModelEgressEntry[] = [];
  async recordEgress(entry: ModelEgressEntry): Promise<void> {
    this.entries.push(entry);
  }
}

const ROUTES = {
  pipeline: { provider: 'mistral', model: 'small' },
  answer: { provider: 'anthropic', model: 'big' },
  embedding: { provider: 'mistral', model: 'embed' },
};

const audited = (inner: ModelGateway, audit: CollectingAudit) =>
  new AuditedModelGateway(inner, audit, ROUTES, false);

describe('model egress audit', () => {
  it('every_call_is_recorded: complete, stream, structured and embed each write one entry', async () => {
    const audit = new CollectingAudit();
    const gateway = audited(new RecordingGateway(), audit);

    await gateway.complete({ input: SECRET_INPUT });
    for await (const _ of gateway.completeStream({ input: SECRET_INPUT })) void _;
    await gateway.extractStructured(z.object({ claim: z.string() }), {
      system: 'prompt',
      input: SECRET_INPUT,
      tier: 'pipeline',
    });
    await gateway.embed([SECRET_INPUT, 'and another']);

    expect(audit.entries.map((e) => e.operation)).toEqual([
      'complete',
      'completeStream',
      'extractStructured',
      'embed',
    ]);
    // Each names where the bytes went, by tier and by resolved model.
    expect(audit.entries.map((e) => `${e.tier}:${e.provider}/${e.model}`)).toEqual([
      'answer:anthropic/big',
      'answer:anthropic/big',
      'pipeline:mistral/small',
      'embedding:mistral/embed',
    ]);
    for (const entry of audit.entries) expect(entry.detail['ok']).toBe(true);
  });

  it('no_content_in_the_entry: not the prompt, not the completion, not a fragment', async () => {
    const audit = new CollectingAudit();
    const gateway = audited(new RecordingGateway(), audit);

    await gateway.complete({ system: SECRET_INPUT, input: SECRET_INPUT });
    for await (const _ of gateway.completeStream({ input: SECRET_INPUT })) void _;
    await gateway.extractStructured(z.object({ claim: z.string() }), {
      system: 'prompt',
      input: SECRET_INPUT,
    });
    await gateway.embed([SECRET_INPUT]);

    const serialised = JSON.stringify(audit.entries);
    for (const word of [...SECRET_INPUT.split(' '), ...SECRET_OUTPUT.split(' ')]) {
      // Every word of both, not just the whole string: a truncated excerpt is
      // still content.
      if (word.length < 4) continue;
      expect(serialised).not.toContain(word);
    }
    // What IS there is the size of what moved.
    expect(audit.entries[0]!.detail).toMatchObject({
      inputChars: SECRET_INPUT.length,
      outputChars: SECRET_OUTPUT.length,
      inputTokens: 11,
      outputTokens: 7,
    });
  });

  it('failures_record_the_class_not_the_message: an upstream error names no endpoint', async () => {
    const audit = new CollectingAudit();
    const gateway = audited(new ExplodingGateway(), audit);

    await expect(gateway.complete({ input: SECRET_INPUT })).rejects.toThrow(/upstream said no/);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]!.detail).toMatchObject({ ok: false, errorClass: 'TypeError' });
    expect(JSON.stringify(audit.entries[0])).not.toContain('api.example');
  });

  it('a_failed_write_never_fails_the_call: the answer was already produced', async () => {
    const gateway = new AuditedModelGateway(
      new RecordingGateway(),
      {
        recordEgress: async () => {
          throw new Error('audit table unavailable');
        },
      },
      ROUTES,
      false,
    );
    await expect(gateway.complete({ input: 'x' })).resolves.toMatchObject({ text: SECRET_OUTPUT });
  });

  it('factory_wires_it_when_asked_and_omits_it_otherwise: eval runs write no entries', async () => {
    const audit = new CollectingAudit();
    // No providers configured: the call fails at the adapter, and the point is
    // only whether the decorator is in the chain at all.
    const withAudit = createModelGateway({ egressAudit: audit });
    await expect(withAudit.complete({ input: 'x' })).rejects.toThrow();
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]!.detail['ok']).toBe(false);

    // Undecorated, the unconfigured gateway throws synchronously — which is
    // itself the proof that nothing wrapped it.
    const withoutAudit = createModelGateway({});
    expect(() => withoutAudit.complete({ input: 'x' })).toThrow();
    expect(audit.entries).toHaveLength(1); // unchanged
  });
});
