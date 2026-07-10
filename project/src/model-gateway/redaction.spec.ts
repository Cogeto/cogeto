import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ZodType, ZodTypeDef } from 'zod';
import { ModelGateway } from './model-gateway.service';
import type {
  CompletionRequest,
  CompletionResult,
  StructuredExtractionRequest,
} from './model-gateway.service';
import { RedactingModelGateway } from './redacting.gateway';
import { RedactionClient } from './redaction-client';
import type { RedactionPort, RedactionResult } from './redaction-client';
import { createModelGateway } from './factory';
import { MistralModelGateway } from './mistral.gateway';
import { ModelGatewayError } from './errors';
import { reidentifyDeep, reidentifyStream, reidentifyText } from './redaction-utils';

/**
 * Redaction mode gateway wiring (Addendum B.8; decisions 0002, 0023).
 * redaction_in_path / redaction_fail_closed / redaction_off_noop are here; the
 * detection + pseudonymize/reidentify correctness (redaction_roundtrip,
 * redaction_consistent) live in the Python sidecar's tests.
 */

// A deterministic stand-in for the Presidio sidecar: fixed entity → pseudonym.
// Bracketed lowercase slots, matching the real sidecar format (redactor.py).
const ENTITIES: Record<string, string> = {
  'Ana Kovač': '[person1]',
  Marko: '[person2]',
  'Adriatic Foods': '[company1]',
  '€48,000': '[amount1]',
};

class FakeRedactor implements RedactionPort {
  calls = 0;
  async pseudonymize(text: string): Promise<RedactionResult> {
    this.calls += 1;
    let out = text;
    const mapping: Record<string, string> = {};
    for (const [original, pseudonym] of Object.entries(ENTITIES)) {
      if (out.includes(original)) {
        out = out.split(original).join(pseudonym);
        mapping[pseudonym] = original;
      }
    }
    return { text: out, mapping };
  }
  async health(): Promise<void> {}
}

// Records exactly what reached "Mistral", and answers in pseudonym space.
class RecordingUpstream extends ModelGateway {
  lastInput: string | null = null;
  embedInputs: string[] = [];
  called = false;

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.called = true;
    this.lastInput = request.input;
    // The model echoes the pseudonymized entities in its answer.
    return { text: `Noted: ${request.input}` };
  }
  async *completeStream(request: CompletionRequest): AsyncIterable<string> {
    this.called = true;
    this.lastInput = request.input;
    for (const piece of ['Sending to ', '[person2]', ' now.']) yield piece;
  }
  async extractStructured<T>(
    _schema: ZodType<T, ZodTypeDef, unknown>,
    request: StructuredExtractionRequest,
  ): Promise<T> {
    this.called = true;
    this.lastInput = request.input;
    return {
      content: '[person1] promised [person2] the proposal',
      people: ['[person1]', '[person2]'],
    } as T;
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.called = true;
    this.embedInputs = texts;
    return texts.map(() => [0.1, 0.2, 0.3]);
  }
  embeddingModelId(): string {
    return 'fake-embed';
  }
}

const NOTE = 'Ana Kovač at Adriatic Foods confirmed the €48,000 fee for Marko.';

describe('redaction_in_path', () => {
  it('sends only pseudonyms to the upstream and re-identifies the response', async () => {
    const upstream = new RecordingUpstream();
    const gateway = new RedactingModelGateway(upstream, new FakeRedactor());

    const result = await gateway.complete({ input: NOTE });

    // Outbound payload carries no real entity string.
    for (const real of Object.keys(ENTITIES)) expect(upstream.lastInput).not.toContain(real);
    expect(upstream.lastInput).toContain('[person1]');
    // Response re-identified for the caller.
    expect(result.text).toContain('Ana Kovač');
    expect(result.text).not.toContain('[person1]');
  });

  it('re-identifies every string in a structured extraction result', async () => {
    const upstream = new RecordingUpstream();
    const gateway = new RedactingModelGateway(upstream, new FakeRedactor());
    const schema = z.object({ content: z.string(), people: z.array(z.string()) });

    const out = await gateway.extractStructured(schema, { system: 'prompt', input: NOTE });

    expect(upstream.lastInput).not.toContain('Ana Kovač');
    expect(out.content).toBe('Ana Kovač promised Marko the proposal');
    expect(out.people).toEqual(['Ana Kovač', 'Marko']);
  });

  it('redacts embedding inputs too (decision 0023)', async () => {
    const upstream = new RecordingUpstream();
    const gateway = new RedactingModelGateway(upstream, new FakeRedactor());

    await gateway.embed([NOTE]);

    expect(upstream.embedInputs[0]).not.toContain('Ana Kovač');
    expect(upstream.embedInputs[0]).toContain('[person1]');
  });

  it('re-identifies a streamed completion without splitting a pseudonym', async () => {
    const upstream = new RecordingUpstream();
    const gateway = new RedactingModelGateway(upstream, new FakeRedactor());

    let text = '';
    for await (const delta of gateway.completeStream({ input: NOTE })) text += delta;

    expect(text).toBe('Sending to Marko now.');
  });
});

describe('redaction_fail_closed', () => {
  it('fails the model call — never plaintext — when the sidecar is unreachable', async () => {
    const upstream = new RecordingUpstream();
    // A real client pointed at a dead address: connection refused → fail closed.
    const client = new RedactionClient('http://127.0.0.1:1', 200);
    const gateway = new RedactingModelGateway(upstream, client);

    await expect(gateway.complete({ input: NOTE })).rejects.toBeInstanceOf(ModelGatewayError);
    await expect(gateway.embed([NOTE])).rejects.toBeInstanceOf(ModelGatewayError);
    // The upstream (Mistral) was NEVER called with any text.
    expect(upstream.called).toBe(false);
    expect(upstream.lastInput).toBeNull();
  });

  it('a sidecar 5xx also fails closed', async () => {
    const throwing: RedactionPort = {
      pseudonymize: () => Promise.reject(new ModelGatewayError('sidecar 500', false)),
      health: () => Promise.resolve(),
    };
    const upstream = new RecordingUpstream();
    const gateway = new RedactingModelGateway(upstream, throwing);
    await expect(gateway.complete({ input: NOTE })).rejects.toBeInstanceOf(ModelGatewayError);
    expect(upstream.called).toBe(false);
  });
});

describe('redaction_off_noop', () => {
  it('the factory returns the bare gateway (not wrapped) when redaction is off', () => {
    const off = createModelGateway({ mistralApiKey: 'k' });
    expect(off).toBeInstanceOf(MistralModelGateway);
    expect(off).not.toBeInstanceOf(RedactingModelGateway);

    const disabled = createModelGateway({
      mistralApiKey: 'k',
      redaction: { enabled: false, url: 'http://redaction:8080' },
    });
    expect(disabled).not.toBeInstanceOf(RedactingModelGateway);

    const on = createModelGateway({
      mistralApiKey: 'k',
      redaction: { enabled: true, url: 'http://redaction:8080' },
    });
    expect(on).toBeInstanceOf(RedactingModelGateway);
  });
});

describe('reidentify (pure)', () => {
  it('reverses text; the bracketed slot never clobbers [person10] or a bare token', () => {
    const mapping = { '[person1]': 'Ana', '[person10]': 'Zed' };
    expect(reidentifyText('[person1] and [person10]', mapping)).toBe('Ana and Zed');
    // A user's own literal "person1" (no brackets) is left untouched.
    expect(reidentifyText('person1 says [person1]', mapping)).toBe('person1 says Ana');
  });

  it('reverses nested structures', () => {
    const mapping = { '[person1]': 'Ana', '[company1]': 'Adriatic Foods' };
    expect(
      reidentifyDeep(
        { a: '[person1]', b: ['[company1]', { c: '[person1] at [company1]' }], n: 5 },
        mapping,
      ),
    ).toEqual({ a: 'Ana', b: ['Adriatic Foods', { c: 'Ana at Adriatic Foods' }], n: 5 });
  });

  it('streams re-identification across chunk boundaries', async () => {
    async function* src(): AsyncIterable<string> {
      yield 'hi [pers';
      yield 'on1] and [per';
      yield 'son2] done';
    }
    let out = '';
    for await (const s of reidentifyStream(src(), { '[person1]': 'Ana', '[person2]': 'Marko' }))
      out += s;
    expect(out).toBe('hi Ana and Marko done');
  });
});
