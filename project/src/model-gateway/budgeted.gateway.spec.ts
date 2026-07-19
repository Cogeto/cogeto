import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { z } from 'zod';
import { ModelGateway } from './model-gateway.service';
import type { CompletionRequest, StructuredExtractionRequest } from './model-gateway.service';
import { BudgetedModelGateway } from './budgeted.gateway';
import { ModelBudgetExceededError } from './errors';
import type { ModelUsageMeter } from '../infrastructure/index';

/** A gateway that records what it was asked and returns canned output. */
class RecordingGateway extends ModelGateway {
  calls = 0;
  async complete(_request: CompletionRequest) {
    this.calls++;
    return { text: 'the answer text' };
  }
  async *completeStream(_request: CompletionRequest): AsyncIterable<string> {
    this.calls++;
    yield 'hello ';
    yield 'world';
  }
  async extractStructured<T>(
    schema: ZodType<T, unknown>,
    _r: StructuredExtractionRequest,
  ): Promise<T> {
    this.calls++;
    return schema.parse({ ok: true });
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map(() => [0]);
  }
  embeddingModelId() {
    return 'test-embed';
  }
}

/** A scriptable meter (FIX-2 QS-2). */
class FakeMeter implements ModelUsageMeter {
  userId: string | undefined = 'user-a';
  budget = true;
  records: { userId: string; tokens: number }[] = [];
  currentUserId() {
    return this.userId;
  }
  hasBudget(_userId: string) {
    return this.budget;
  }
  record(userId: string, tokens: number) {
    this.records.push({ userId, tokens });
  }
}

describe('BudgetedModelGateway (QS-2)', () => {
  it('records usage for an attributed user and forwards the result', async () => {
    const inner = new RecordingGateway();
    const meter = new FakeMeter();
    const gateway = new BudgetedModelGateway(inner, meter);

    const result = await gateway.complete({ input: 'a question' });
    expect(result.text).toBe('the answer text');
    expect(inner.calls).toBe(1);
    expect(meter.records).toHaveLength(1);
    expect(meter.records[0]!.userId).toBe('user-a');
    expect(meter.records[0]!.tokens).toBeGreaterThan(0);
  });

  it('throws ModelBudgetExceededError BEFORE calling the provider when over budget', async () => {
    const inner = new RecordingGateway();
    const meter = new FakeMeter();
    meter.budget = false;
    const gateway = new BudgetedModelGateway(inner, meter);

    await expect(gateway.complete({ input: 'q' })).rejects.toBeInstanceOf(ModelBudgetExceededError);
    expect(inner.calls).toBe(0); // gated before the provider call
    expect(meter.records).toHaveLength(0);
  });

  it('leaves unattributed calls (no user in scope) unmetered', async () => {
    const inner = new RecordingGateway();
    const meter = new FakeMeter();
    meter.userId = undefined;
    meter.budget = false; // would block if it were consulted
    const gateway = new BudgetedModelGateway(inner, meter);

    const result = await gateway.complete({ input: 'q' });
    expect(result.text).toBe('the answer text');
    expect(inner.calls).toBe(1);
    expect(meter.records).toHaveLength(0); // nothing charged
  });

  it('meters a stream after it finishes, counting the accumulated output', async () => {
    const inner = new RecordingGateway();
    const meter = new FakeMeter();
    const gateway = new BudgetedModelGateway(inner, meter);

    let text = '';
    for await (const delta of gateway.completeStream({ input: 'question' })) text += delta;
    expect(text).toBe('hello world');
    expect(meter.records).toHaveLength(1);
  });

  it('extractStructured stays validated and metered', async () => {
    const inner = new RecordingGateway();
    const meter = new FakeMeter();
    const gateway = new BudgetedModelGateway(inner, meter);
    const schema = z.object({ ok: z.boolean() });
    const out = await gateway.extractStructured(schema, { system: 's', input: 'i' });
    expect(out).toEqual({ ok: true });
    expect(meter.records).toHaveLength(1);
  });
});
