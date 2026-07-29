import { Injectable } from '@nestjs/common';
import { loadPrompt, ModelGateway } from '../../model-gateway/index';
import type { PromptArtifact } from '../../model-gateway/index';
import { verificationBatchOutputSchema, verificationOutputSchema } from '../domain/candidate-fact';
import type { CandidateFact } from '../domain/candidate-fact';
import type { VerificationVerdict } from '../persistence/tables';
import { VERIFICATION_BATCH_PROMPT, VERIFICATION_PROMPT } from '../prompt-versions';
import type { Chunk } from './chunk';

/** How much source text around the cited span the verifier sees. */
const CONTEXT_WINDOW_CHARS = 240;

/** Claims judged per batched call: a 100-fact source is 10
 * calls, not 100. Each claim still carries its own passage + context and is
 * judged independently by the prompt's contract. */
export const VERIFY_BATCH_SIZE = 10;

export interface VerifiedFact {
  fact: CandidateFact;
  verdict: VerificationVerdict;
  reason: string;
  promptVersion: string;
}

/**
 * Stage 4 (verify): the independent spec §2 pass — through a prompt family that
 * shares no wording or rubric with the extractor (no grading your own homework
 * with the same rubric). The verdict decides admission: supported → active,
 * partial/unsupported → uncertain.
 *
 * Call shape: a single-fact source keeps the one-claim contract
 * (verification/v0004) unchanged; multi-fact sources are judged in batches of
 * VERIFY_BATCH_SIZE through the batch form (verification/v0005 — the same
 * rubric, an enveloped input/output). A claim the reply omits is treated as
 * unsupported: conservative, and admission-safe (it lands `uncertain`).
 */
@Injectable()
export class VerifyStage {
  private prompt?: PromptArtifact;
  private batchPrompt?: PromptArtifact;

  constructor(private readonly gateway: ModelGateway) {}

  async run(chunks: Chunk[], facts: CandidateFact[]): Promise<VerifiedFact[]> {
    if (facts.length === 0) return [];
    if (facts.length === 1) {
      const prompt = await this.getPrompt();
      const promptVersion = `${VERIFICATION_PROMPT.family}/${VERIFICATION_PROMPT.version}`;
      const fact = facts[0]!;
      const output = await this.gateway.extractStructured(verificationOutputSchema, {
        system: prompt.content,
        input: buildVerificationInput(fact, chunks),
      });
      return [{ fact, verdict: output.verdict, reason: output.reason, promptVersion }];
    }

    const prompt = await this.getBatchPrompt();
    const promptVersion = `${VERIFICATION_BATCH_PROMPT.family}/${VERIFICATION_BATCH_PROMPT.version}`;
    const verified: VerifiedFact[] = [];
    for (let at = 0; at < facts.length; at += VERIFY_BATCH_SIZE) {
      const batch = facts.slice(at, at + VERIFY_BATCH_SIZE);
      const output = await this.gateway.extractStructured(verificationBatchOutputSchema, {
        system: prompt.content,
        input: buildVerificationBatchInput(batch, chunks),
      });
      const byClaim = new Map(output.verdicts.map((v) => [v.claim, v]));
      batch.forEach((fact, i) => {
        const verdict = byClaim.get(i + 1);
        verified.push(
          verdict
            ? { fact, verdict: verdict.verdict, reason: verdict.reason, promptVersion }
            : {
                fact,
                verdict: 'unsupported',
                reason: 'no verdict returned for this claim, treated as unsupported',
                promptVersion,
              },
        );
      });
    }
    return verified;
  }

  private async getPrompt(): Promise<PromptArtifact> {
    this.prompt ??= await loadPrompt(VERIFICATION_PROMPT.family, VERIFICATION_PROMPT.version);
    return this.prompt;
  }

  private async getBatchPrompt(): Promise<PromptArtifact> {
    this.batchPrompt ??= await loadPrompt(
      VERIFICATION_BATCH_PROMPT.family,
      VERIFICATION_BATCH_PROMPT.version,
    );
    return this.batchPrompt;
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

/** The batch envelope (verification/v0005): numbered claim blocks, each with
 * its own passage + minimal context, judged independently. */
export function buildVerificationBatchInput(facts: CandidateFact[], chunks: Chunk[]): string {
  const blocks = facts.map((fact, i) => {
    const single = buildVerificationInput(fact, chunks);
    return single
      .replace('CLAIM UNDER REVIEW:', `CLAIM ${i + 1}:`)
      .replace('CITED PASSAGE:', `CITED PASSAGE ${i + 1}:`)
      .replace('SURROUNDING SOURCE TEXT:', `SURROUNDING SOURCE TEXT ${i + 1}:`);
  });
  return [
    `CLAIMS UNDER REVIEW: ${facts.length} claims. Judge each independently.`,
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
