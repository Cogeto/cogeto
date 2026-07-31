import { Injectable } from '@nestjs/common';
import {
  fenceUntrusted,
  loadPrompt,
  ModelGateway,
  untrustedBoundary,
} from '../../model-gateway/index';
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
  /**
   * False when the batched reply carried no verdict for this claim. The stored
   * verdict stays the conservative `unsupported` (admission is unchanged), but
   * the DECISION is that support could not be determined, which the admission
   * taxonomy reports as `unjudgeable` rather than as a negative judgment
   * (V2.0 item 3.3).
   */
  judged: boolean;
  /**
   * Whether the cited span was found verbatim in the source text handed to the
   * verifier. When it was not, the verifier judged against a fallback window, so
   * a negative verdict is not attributable to the cited evidence.
   */
  spanLocatable: boolean;
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
      return [
        {
          fact,
          verdict: output.verdict,
          reason: output.reason,
          promptVersion,
          judged: true,
          spanLocatable: spanLocatable(fact, chunks),
        },
      ];
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
        const locatable = spanLocatable(fact, chunks);
        verified.push(
          verdict
            ? {
                fact,
                verdict: verdict.verdict,
                reason: verdict.reason,
                promptVersion,
                judged: true,
                spanLocatable: locatable,
              }
            : {
                fact,
                verdict: 'unsupported',
                reason: 'no verdict returned for this claim, treated as unsupported',
                promptVersion,
                judged: false,
                spanLocatable: locatable,
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
 * Was the cited span found verbatim in the source the verifier saw? This is the
 * same lookup `buildVerificationInput` performs to centre its context window,
 * surfaced as a signal: when it fails, the verifier was shown a fallback window
 * instead of the cited evidence, so its verdict is not attributable to that
 * evidence and the admission taxonomy calls the outcome `unjudgeable`.
 *
 * Note what this is NOT: proof of a fabricated span. Chunking can split a
 * legitimate span across a boundary. That is exactly why an unlocatable span is
 * never grounds for non-admission, only for an honest "could not judge".
 */
export function spanLocatable(fact: CandidateFact, chunks: Chunk[]): boolean {
  return chunks.some((chunk) => chunk.text.includes(fact.source_span));
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
  // SEC-4: the passage and its surrounding text are the document verbatim, so
  // both are fenced.
  //
  // The CLAIM is deliberately NOT fenced. Fencing all three cost 9.4 points of
  // verification agreement (90.5% to 81.1%) in the golden set: this prompt's
  // whole job is to compare the claim against the passage, and burying the
  // comparison target in marker lines makes that harder, at three fences per
  // claim across a batch. The claim is also our own generated sentence rather
  // than raw document text, and it is short, so it is the weakest of the three
  // injection carriers. Fencing the two document spans keeps the defence where
  // the hostile text actually is. Measured again after the change: 90.5%.
  const boundary = untrustedBoundary();
  return [
    'CLAIM UNDER REVIEW:',
    fact.claim,
    '',
    'CITED PASSAGE:',
    fenceUntrusted(fact.source_span, boundary),
    '',
    'SURROUNDING SOURCE TEXT:',
    fenceUntrusted(context, boundary),
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
