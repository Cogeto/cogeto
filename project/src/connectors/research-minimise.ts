import { z } from 'zod';
import { loadPrompt, ModelGateway } from '../model-gateway/index';
import type { PromptArtifact } from '../model-gateway/index';

/**
 * Query minimisation (Priority 5 Part B, decision 0044): rewrite a proposed
 * search query to the least-identifying form that still serves the research
 * intent, BEFORE the gate shows it (decision 0045). Pseudonymising a query
 * breaks it — the redaction sidecar's NER swap cannot do this — so the
 * backlog's "redaction-tier pass" is realised as a small-model rewrite on the
 * pipeline tier through the normal gateway (itself redaction-wrapped when the
 * profile is on). Conservative by prompt: when unsure whether an entity is
 * essential, KEEP it and let the user decide at the gate.
 *
 * Fail-open to the GATE, never to the network: if the model call fails, the
 * proposed query is returned UNCHANGED with a reason saying minimisation was
 * unavailable — the user still sees and approves exactly what would leave, so
 * the failure mode is "review it yourself", not "silently sent".
 */

export const RESEARCH_MINIMISE_PROMPT = { family: 'research_query_minimise', version: 'v0002' };

const minimiseSchema = z.object({
  minimised_query: z.string().min(1),
  removed: z.array(z.string()).default([]),
  kept: z.array(z.string()).default([]),
  reason: z.string().min(1),
});

export interface MinimisedQuery {
  /** The proposed query, unchanged — always reported alongside (decision 0044). */
  original: string;
  minimised: string;
  reason: string;
}

let prompt: PromptArtifact | undefined;

export async function minimiseQuery(
  gateway: ModelGateway,
  intent: string,
  proposedQuery: string,
): Promise<MinimisedQuery> {
  prompt ??= await loadPrompt(RESEARCH_MINIMISE_PROMPT.family, RESEARCH_MINIMISE_PROMPT.version);
  try {
    const output = await gateway.extractStructured(minimiseSchema, {
      system: prompt.content,
      input: `RESEARCH INTENT:\n${intent}\n\nPROPOSED QUERY:\n${proposedQuery}`,
      // tier omitted → the pipeline tier (the small model), never answer.
    });
    return { original: proposedQuery, minimised: output.minimised_query, reason: output.reason };
  } catch {
    return {
      original: proposedQuery,
      minimised: proposedQuery,
      reason: 'minimisation was unavailable — review the query yourself before approving',
    };
  }
}
