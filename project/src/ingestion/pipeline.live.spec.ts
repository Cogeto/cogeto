import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MistralModelGateway } from '../model-gateway/index';
import { VERIFICATION_VERDICTS } from './domain/candidate-fact';
import { chunkContent } from './pipeline/chunk';
import { ExtractStage } from './pipeline/extract.stage';
import type { SourceItem } from './pipeline/source-reader';
import { VerifyStage } from './pipeline/verify.stage';

const apiKey = process.env.COGETO_MISTRAL_API_KEY || process.env.MISTRAL_API_KEY;

/**
 * Live-optional round trip: the canonical commitment fixture through the real
 * extraction + verification prompts against the Mistral API. Skipped without
 * an API key; deterministic behavior is covered by pipeline.integration.spec.
 */
describe.skipIf(!apiKey)('pipeline stages 3-4 (live, real Mistral API)', () => {
  it('live_roundtrip: the canonical commitment note extracts and verifies', async () => {
    const gateway = new MistralModelGateway({ apiKey: apiKey as string });
    const content = await readFile(
      path.resolve(
        __dirname,
        '..',
        '..',
        'eval',
        'golden',
        'en',
        'en-0001-canonical-commitment',
        'source.txt',
      ),
      'utf8',
    );
    const source: SourceItem = {
      sourceType: 'user_note',
      sourceId: 'live-fixture-en-0001',
      ownerId: 'live-user',
      content,
      createdAt: new Date('2026-07-02T10:00:00Z'),
    };

    const chunks = chunkContent(source.content);
    expect(chunks).toHaveLength(1); // under the threshold: one chunk, verbatim

    const facts = await new ExtractStage(gateway).run(source, chunks);
    expect(facts.length).toBeGreaterThanOrEqual(1);
    const commitment = facts.find((f) => f.kind === 'commitment') ?? facts[0]!;
    expect(commitment.claim).toMatch(/Luka/);
    expect(content).toContain(commitment.source_span);

    const verified = await new VerifyStage(gateway).run(chunks, [commitment]);
    expect(verified).toHaveLength(1);
    expect(VERIFICATION_VERDICTS).toContain(verified[0]!.verdict);
    // The claim restates the note: a correct verifier does not reject it.
    expect(verified[0]!.verdict).not.toBe('unsupported');
  });
});
