/**
 * The prompt versions the pipeline currently runs (§B.7). Bumping a version
 * here (after adding the new numbered artifact + changelog entry) is what
 * activates it; the worker registers these in prompt_registry on boot, which
 * also enforces immutability of released versions via the content hash.
 */
export interface PromptVersionRef {
  family: string;
  version: string;
}

export const EXTRACTION_PROMPT: PromptVersionRef = { family: 'extraction', version: 'v0002' };
export const VERIFICATION_PROMPT: PromptVersionRef = { family: 'verification', version: 'v0004' };
export const RECONCILE_DEDUP_PROMPT: PromptVersionRef = {
  family: 'reconcile_dedup',
  version: 'v0001',
};
export const RECONCILE_CONTRADICTION_PROMPT: PromptVersionRef = {
  family: 'reconcile_contradiction',
  version: 'v0001',
};

export const ACTIVE_PROMPTS: readonly PromptVersionRef[] = [
  EXTRACTION_PROMPT,
  VERIFICATION_PROMPT,
  RECONCILE_DEDUP_PROMPT,
  RECONCILE_CONTRADICTION_PROMPT,
];
