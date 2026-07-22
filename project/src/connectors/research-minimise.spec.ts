import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { ModelGateway } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import { minimiseQuery, RESEARCH_MINIMISE_PROMPT } from './research-minimise';

/**
 * Query minimisation (decision 0044). The LIVE rewriting behaviour is graded
 * by the research chat-eval cases (research_minimise_drop /
 * research_keeps_subject_hr); here the CONTRACT is pinned: the plumbing
 * (minimise_reports), the pipeline-tier routing, the fail-open-to-the-gate
 * fallback, and — as a regression tripwire — the prompt's two load-bearing
 * rules (drop anchoring entities on general intents; keep subject entities;
 * keep when unsure).
 */

class ScriptedMinimiser extends ModelGateway {
  lastTier: string | undefined = 'unset';
  lastInput = '';
  constructor(private readonly output: () => unknown) {
    super();
  }
  complete(): never {
    throw new Error('unused');
  }
  // eslint-disable-next-line require-yield -- unused
  async *completeStream(): AsyncIterable<string> {
    throw new Error('unused');
  }
  async embed(): Promise<number[][]> {
    throw new Error('unused');
  }
  embeddingModelId(): string {
    return 'unused';
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    this.lastTier = request.tier;
    this.lastInput = request.input;
    const parsed = schema.safeParse(this.output());
    if (!parsed.success) throw new Error('scripted output failed schema');
    return parsed.data;
  }
}

describe('query minimisation (decision 0044)', () => {
  it('minimise_reports: returns the original, the minimised query, and the one-line reason', async () => {
    const gateway = new ScriptedMinimiser(() => ({
      minimised_query: 'GDPR consent requirements CRM migration',
      removed: ['Adriatic Foods'],
      kept: [],
      reason: 'Removed the client name — the question is general GDPR/CRM guidance.',
    }));
    const result = await minimiseQuery(
      gateway,
      'research how we handle GDPR consent for Adriatic Foods when migrating CRM',
      'Adriatic Foods GDPR consent CRM migration',
    );
    expect(result).toEqual({
      original: 'Adriatic Foods GDPR consent CRM migration',
      minimised: 'GDPR consent requirements CRM migration',
      reason: 'Removed the client name — the question is general GDPR/CRM guidance.',
    });
    // Pipeline tier (the small model): the tier is left at the structured
    // default — never 'answer'.
    expect(gateway.lastTier).toBeUndefined();
    // Both blocks reach the model so intent can justify keeping an entity.
    expect(gateway.lastInput).toContain('RESEARCH INTENT:');
    expect(gateway.lastInput).toContain('PROPOSED QUERY:');
  });

  it('minimise_drops_client: a general-intent query loses the client name (contract + prompt rule)', async () => {
    const gateway = new ScriptedMinimiser(() => ({
      minimised_query: 'GDPR consent requirements CRM migration',
      removed: ['Adriatic Foods'],
      kept: [],
      reason: 'Client name removed; the intent is general.',
    }));
    const result = await minimiseQuery(
      gateway,
      'GDPR consent for Adriatic Foods CRM migration',
      'Adriatic Foods GDPR consent CRM migration',
    );
    expect(result.minimised).not.toContain('Adriatic Foods');
    expect(result.original).toContain('Adriatic Foods'); // the gate can still show the diff
    // The prompt rule that produces this behaviour is present verbatim.
    expect(promptText()).toContain('DROP the entity');
  });

  it('minimise_keeps_subject: a query whose subject IS the entity keeps it (contract + prompt rule)', async () => {
    const gateway = new ScriptedMinimiser(() => ({
      minimised_query: 'Adriatic Foods d.o.o. company profile',
      removed: [],
      kept: ['Adriatic Foods'],
      reason: 'Kept the company name — researching it is the point.',
    }));
    const result = await minimiseQuery(
      gateway,
      'research Adriatic Foods before Thursday',
      'Adriatic Foods d.o.o. company profile',
    );
    expect(result.minimised).toContain('Adriatic Foods');
    const prompt = promptText();
    expect(prompt).toContain('KEEP it');
    expect(prompt).toContain('When unsure whether an entity is essential, KEEP it');
  });

  it('fails OPEN TO THE GATE: an unavailable model returns the query unchanged with an honest reason', async () => {
    const gateway = new ScriptedMinimiser(() => {
      throw new Error('model down');
    });
    const result = await minimiseQuery(gateway, 'intent', 'Adriatic Foods pricing');
    expect(result.minimised).toBe('Adriatic Foods pricing');
    expect(result.reason).toContain('review the query yourself');
  });
});

function promptText(): string {
  return readFileSync(
    path.resolve(
      process.cwd(),
      '..',
      'prompts',
      RESEARCH_MINIMISE_PROMPT.family,
      `${RESEARCH_MINIMISE_PROMPT.version}.md`,
    ),
    'utf8',
  );
}
