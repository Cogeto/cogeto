import { Injectable } from '@nestjs/common';
import { loadPrompt, ModelGateway } from '../../model-gateway/index';
import type { PromptArtifact } from '../../model-gateway/index';
import { extractionOutputSchema } from '../domain/candidate-fact';
import type { CandidateFact } from '../domain/candidate-fact';
import { EXTRACTION_PROMPT } from '../prompt-versions';
import type { Chunk } from './chunk';
import type { SourceItem } from './source-reader';

/**
 * Stage 3 (extract): structured extraction of candidate facts per chunk via
 * the versioned extraction prompt. Output is Zod-validated at the gateway;
 * malformed output throws and is never stored — the job retries with backoff
 * and dead-letters if it never conforms (§A.3).
 */
@Injectable()
export class ExtractStage {
  private prompt?: PromptArtifact;

  constructor(private readonly gateway: ModelGateway) {}

  async run(source: SourceItem, chunks: Chunk[]): Promise<CandidateFact[]> {
    if (chunks.length === 0) return [];
    const prompt = await this.getPrompt();
    const facts: CandidateFact[] = [];
    for (const chunk of chunks) {
      const output = await this.gateway.extractStructured(extractionOutputSchema, {
        system: prompt.content,
        input: buildExtractionInput(source, chunk),
      });
      // Provenance guard: a weaker model can grab one of the input's ALL-CAPS
      // metadata labels (REFERENCE TIME / SOURCE TYPE / SOURCE CONTENT) as if it
      // were content — most visible under redaction, where the real names become
      // bracketed slots and the labels are the only capitalized tokens left. Such
      // a "fact" is never grounded in SOURCE CONTENT; drop it rather than store it.
      facts.push(...output.facts.filter((fact) => !carriesMetadataLabel(fact)));
    }
    return facts;
  }

  get promptVersion(): string {
    return `${EXTRACTION_PROMPT.family}/${EXTRACTION_PROMPT.version}`;
  }

  private async getPrompt(): Promise<PromptArtifact> {
    this.prompt ??= await loadPrompt(EXTRACTION_PROMPT.family, EXTRACTION_PROMPT.version);
    return this.prompt;
  }
}

/**
 * Labeled context blocks (research: retrieval-and-pipeline §4). The reference
 * time is a per-source input, not part of the immutable prompt artifact.
 */
export function buildExtractionInput(source: SourceItem, chunk: Chunk): string {
  return [
    `REFERENCE TIME (when the source was written): ${source.createdAt.toISOString()}`,
    `SOURCE TYPE: ${source.sourceType}`,
    '',
    'SOURCE CONTENT:',
    chunk.text,
  ].join('\n');
}

/** The metadata labels `buildExtractionInput` prepends — never real fact content. */
const METADATA_LABELS = ['REFERENCE TIME', 'SOURCE TYPE', 'SOURCE CONTENT'];

/** True when the model spilled a metadata label into the fact (claim, span, or
 * subject) — a provenance leak, not a real fact. */
export function carriesMetadataLabel(fact: CandidateFact): boolean {
  const fields = [fact.claim, fact.source_span, fact.subject_entity ?? ''];
  return fields.some((field) => METADATA_LABELS.some((label) => field.includes(label)));
}
