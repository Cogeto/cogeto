import { Injectable } from '@nestjs/common';
import { loadPrompt, ModelGateway } from '../../model-gateway/index';
import type { PromptArtifact } from '../../model-gateway/index';
import { verificationOutputSchema } from '../domain/candidate-fact';
import type { CandidateFact } from '../domain/candidate-fact';
import type { VerificationVerdict } from '../persistence/tables';
import { VERIFICATION_PROMPT } from '../prompt-versions';
import type { Chunk } from './chunk';

/** How much source text around the cited span the verifier sees. */
const CONTEXT_WINDOW_CHARS = 240;

export interface VerifiedFact {
  fact: CandidateFact;
  verdict: VerificationVerdict;
  reason: string;
  promptVersion: string;
}

/**
 * Stage 4 (verify): the independent §B.3 pass — one gateway call per fact,
 * through a prompt family that shares no wording or rubric with the extractor
 * (no grading your own homework with the same rubric). The verdict decides
 * admission: supported → active, partial/unsupported → uncertain.
 */
@Injectable()
export class VerifyStage {
  private prompt?: PromptArtifact;

  constructor(private readonly gateway: ModelGateway) {}

  async run(chunks: Chunk[], facts: CandidateFact[]): Promise<VerifiedFact[]> {
    if (facts.length === 0) return [];
    const prompt = await this.getPrompt();
    const promptVersion = `${VERIFICATION_PROMPT.family}/${VERIFICATION_PROMPT.version}`;
    const verified: VerifiedFact[] = [];
    for (const fact of facts) {
      const output = await this.gateway.extractStructured(verificationOutputSchema, {
        system: prompt.content,
        input: buildVerificationInput(fact, chunks),
      });
      verified.push({ fact, verdict: output.verdict, reason: output.reason, promptVersion });
    }
    return verified;
  }

  private async getPrompt(): Promise<PromptArtifact> {
    this.prompt ??= await loadPrompt(VERIFICATION_PROMPT.family, VERIFICATION_PROMPT.version);
    return this.prompt;
  }
}

/**
 * The claim, its cited span, and a minimal window of surrounding source text —
 * deliberately not the extractor's full input, so the verifier judges the
 * evidence rather than re-running the extraction.
 */
export function buildVerificationInput(fact: CandidateFact, chunks: Chunk[]): string {
  const home = chunks.find((chunk) => chunk.text.includes(fact.source_span)) ?? chunks[0];
  let context = home?.text ?? fact.source_span;
  if (home) {
    const at = home.text.indexOf(fact.source_span);
    if (at >= 0) {
      context = home.text.slice(
        Math.max(0, at - CONTEXT_WINDOW_CHARS),
        Math.min(home.text.length, at + fact.source_span.length + CONTEXT_WINDOW_CHARS),
      );
    }
  }
  return [
    'CLAIM UNDER REVIEW:',
    fact.claim,
    '',
    'CITED PASSAGE:',
    fact.source_span,
    '',
    'SURROUNDING SOURCE TEXT:',
    context,
  ].join('\n');
}
