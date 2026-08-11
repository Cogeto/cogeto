/**
 * The prompt versions the pipeline currently runs (spec §12.3). Bumping a version
 * here (after adding the new numbered artifact + changelog entry) is what
 * activates it; the worker registers these in prompt_registry on boot, which
 * also enforces immutability of released versions via the content hash.
 */
export interface PromptVersionRef {
  family: string;
  version: string;
}

export const EXTRACTION_PROMPT: PromptVersionRef = { family: 'extraction', version: 'v0006' };
export const VERIFICATION_PROMPT: PromptVersionRef = { family: 'verification', version: 'v0006' };
/** The batch form of v0004 — multi-fact sources only. */
export const VERIFICATION_BATCH_PROMPT: PromptVersionRef = {
  family: 'verification',
  version: 'v0007',
};
export const RECONCILE_DEDUP_PROMPT: PromptVersionRef = {
  family: 'reconcile_dedup',
  version: 'v0001',
};
export const RECONCILE_CONTRADICTION_PROMPT: PromptVersionRef = {
  family: 'reconcile_contradiction',
  version: 'v0002',
};

/** Tier three of the reading ladder (V2.1 item 4.1): reading a page that is a
 * picture. Registered here with every other prompt that decides what Cogeto
 * remembers, because that is exactly what it does. */
export const VISION_READ_PROMPT: PromptVersionRef = { family: 'vision_read', version: 'v0001' };

/** The source-context anchor (V2.1 item 4.2, spec 1.5): what a document as a
 * whole is about, injected into every chunk's extraction call. It decides what
 * Cogeto remembers a fact is ABOUT, so it registers with the rest. */
export const ANCHORING_PROMPT: PromptVersionRef = { family: 'anchoring', version: 'v0001' };

export const ACTIVE_PROMPTS: readonly PromptVersionRef[] = [
  EXTRACTION_PROMPT,
  VERIFICATION_PROMPT,
  VERIFICATION_BATCH_PROMPT,
  RECONCILE_DEDUP_PROMPT,
  RECONCILE_CONTRADICTION_PROMPT,
  VISION_READ_PROMPT,
  ANCHORING_PROMPT,
];
