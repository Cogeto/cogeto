import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { ModelGateway } from '../../model-gateway/index';
import type { StructuredExtractionRequest } from '../../model-gateway/index';
import type { CandidateFact } from '../domain/candidate-fact';
import { buildVerificationBatchInput, VerifyStage } from './verify.stage';

/**
 * Batched verification mechanics, model-free
 *
 *   batched_verification — multi-fact runs batch 10 claims per call; every
 *     claim keeps its own passage + context in the numbered envelope; a claim
 *     the reply OMITS is conservatively unsupported (→ uncertain admission);
 *     single-fact runs keep the v0004 single-claim contract.
 */

const fact = (claim: string): CandidateFact => ({
  claim,
  kind: 'fact',
  entities: { people: [], organizations: [], projects: [] },
  condition: null,
  temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
  source_span: claim,
});

class RecordingGateway extends ModelGateway {
  inputs: string[] = [];
  /** Claim numbers to OMIT from the reply (the conservatism probe). */
  omit = new Set<number>();
  complete(): never {
    throw new Error('unused');
  }
  // eslint-disable-next-line require-yield -- unused
  async *completeStream(): AsyncIterable<string> {
    throw new Error('unused');
  }
  async embed(): Promise<number[][]> {
    return [];
  }
  embeddingModelId(): string {
    return 'test-embed';
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    this.inputs.push(request.input);
    const raw = request.input.startsWith('CLAIMS UNDER REVIEW')
      ? {
          verdicts: [...request.input.matchAll(/CLAIM (\d+):/g)]
            .map((m) => Number(m[1]))
            .filter((n) => !this.omit.has(n))
            .map((n) => ({ claim: n, verdict: 'supported', reason: 'scripted' })),
        }
      : { verdict: 'supported', reason: 'scripted' };
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error('scripted output failed schema');
    return parsed.data;
  }
}

describe('batched_verification', () => {
  it('batches 10 claims per call; each keeps its own numbered passage and context', async () => {
    const gateway = new RecordingGateway();
    const stage = new VerifyStage(gateway);
    const facts = Array.from({ length: 12 }, (_, i) => fact(`Distinct claim number ${i + 1}.`));
    const chunks = [{ text: facts.map((f) => f.claim).join(' '), index: 0 }];

    const verified = await stage.run(chunks, facts);
    expect(verified).toHaveLength(12);
    expect(gateway.inputs).toHaveLength(2); // 10 + 2
    expect(gateway.inputs[0]).toContain('CLAIMS UNDER REVIEW: 10 claims');
    expect(gateway.inputs[0]).toContain('CLAIM 10:');
    expect(gateway.inputs[1]).toContain('CLAIMS UNDER REVIEW: 2 claims');
    expect(verified.every((v) => v.verdict === 'supported')).toBe(true);
    expect(verified[0]!.promptVersion).toBe('verification/v0005');
  });

  it('a claim the reply omits is conservatively unsupported', async () => {
    const gateway = new RecordingGateway();
    gateway.omit.add(2);
    const stage = new VerifyStage(gateway);
    const facts = [fact('First claim.'), fact('Second claim.'), fact('Third claim.')];
    const chunks = [{ text: 'First claim. Second claim. Third claim.', index: 0 }];

    const verified = await stage.run(chunks, facts);
    expect(verified.map((v) => v.verdict)).toEqual(['supported', 'unsupported', 'supported']);
    expect(verified[1]!.reason).toContain('no verdict returned');
  });

  it('a single-fact run keeps the single-claim contract (v0004)', async () => {
    const gateway = new RecordingGateway();
    const stage = new VerifyStage(gateway);
    const verified = await stage.run([{ text: 'Only claim.', index: 0 }], [fact('Only claim.')]);
    expect(gateway.inputs[0]!.startsWith('CLAIM UNDER REVIEW:')).toBe(true);
    expect(verified[0]!.promptVersion).toBe('verification/v0004');
  });

  it('the batch envelope numbers every block per claim', () => {
    const input = buildVerificationBatchInput(
      [fact('Alpha statement.'), fact('Beta statement.')],
      [{ text: 'Alpha statement. Beta statement.', index: 0 }],
    );
    expect(input).toContain('CLAIMS UNDER REVIEW: 2 claims');
    expect(input).toContain('CLAIM 1:');
    expect(input).toContain('CITED PASSAGE 1:');
    expect(input).toContain('SURROUNDING SOURCE TEXT 2:');
  });
});
