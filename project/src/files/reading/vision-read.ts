import { loadPrompt } from '../../model-gateway/index';
import type { ModelGateway, PromptArtifact } from '../../model-gateway/index';
import { VISION_READ_PROMPT } from '../../ingestion/index';

/**
 * Tier three of the reading ladder (V2.1 item 4.1): a page read by a model that
 * can see, because nothing cheaper could read it.
 *
 * The prompt is a versioned artifact like every other prompt that decides what
 * Cogeto remembers (spec §12.3). Its constraints are the substance of this
 * tier: output from here becomes the page's text, and the verification pass
 * then checks extracted claims AGAINST THAT TEXT, so an invented word cannot be
 * caught downstream. The span verification would check is the invention itself.
 * That is why the prompt bans completing patterns and filling in illegible
 * labels, and why `[unreadable]` and an explicit nothing-readable sentinel are
 * first-class answers.
 */

/** What the prompt says when the page has nothing on it. Matched exactly. */
export const NOTHING_READABLE = 'NOTHING READABLE ON THIS PAGE';

/** Bounded so one bad page cannot produce a chapter of hallucinated text. */
export const VISION_MAX_TOKENS = 1600;

export interface VisionPageResult {
  /** The recovered text, already cleaned. Empty when the page had nothing. */
  text: string;
  /** True when the model reported the page as having nothing readable. */
  nothingReadable: boolean;
  /** The prompt artifact that produced it, for provenance. */
  promptVersion: string;
}

let cached: PromptArtifact | undefined;

async function visionPrompt(): Promise<PromptArtifact> {
  cached ??= await loadPrompt(VISION_READ_PROMPT.family, VISION_READ_PROMPT.version);
  return cached;
}

/**
 * Reads one page image. Throws whatever the gateway throws: a vision failure is
 * classified at the seam (unreachable, image rejected, unusable) and the caller
 * records that reason on the page rather than swallowing it.
 */
export async function readPageWithVision(
  gateway: ModelGateway,
  image: { bytes: Buffer; mediaType: string },
  context: { page?: number | null } = {},
): Promise<VisionPageResult> {
  const prompt = await visionPrompt();
  const where = context.page ? `page ${context.page}` : 'this image';
  const result = await gateway.describeImage({
    system: prompt.content,
    input: `Read ${where}. Follow the rules exactly: transcribe and describe only what is visible.`,
    image,
    maxTokens: VISION_MAX_TOKENS,
  });

  const text = cleanVisionOutput(result.text);
  return {
    text: text === NOTHING_READABLE ? '' : text,
    nothingReadable: text === NOTHING_READABLE || text.length === 0,
    promptVersion: `${VISION_READ_PROMPT.family}/${VISION_READ_PROMPT.version}`,
  };
}

/**
 * Strips what models add around an answer no matter how firmly they are asked
 * not to: markdown fences, and a leading apology or preamble before the first
 * labelled section.
 *
 * Deliberately conservative. Anything that is not obviously scaffolding is
 * KEPT: over-trimming would silently delete page content, which is exactly the
 * class of error this tier must not make.
 */
export function cleanVisionOutput(raw: string): string {
  let text = raw.trim();
  // A whole answer wrapped in one fence.
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fenced) text = fenced[1]!.trim();
  if (text === NOTHING_READABLE) return NOTHING_READABLE;

  // A preamble before the first labelled section, and only then: the labels are
  // ours, so anything before them was not asked for.
  const firstLabel = text.search(/^(TEXT:|FIGURE:)/m);
  if (firstLabel > 0) text = text.slice(firstLabel).trim();

  // The sentinel can arrive inside the labelled body of an otherwise empty answer.
  const body = text
    .replace(/^(TEXT:|FIGURE:)/gm, '')
    .replace(/\[unreadable\]/g, '')
    .trim();
  if (body === '' || body === NOTHING_READABLE) return NOTHING_READABLE;
  return text;
}
