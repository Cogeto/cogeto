import { VisionUnavailableError } from './errors';
import { extractStatus } from './provider';

/**
 * Turning a failed image call into an ACTIONABLE reason (V2.1 item 4.1).
 *
 * "Vision failed" is worthless to an operator. The four reasons this produces
 * each point at a different place to look, and the one that matters most is
 * `image_rejected` on a local runtime: a GGUF model is multimodal only when its
 * multimodal projector (the `mmproj` file) is loaded alongside the weights, the
 * SAME weights are served either way, and nothing in the model's name or in
 * `ollama list` says which. An operator told only "the model rejected the
 * image" will go and check the image; an operator told about the projector
 * will go and check the Modelfile, which is where the problem is.
 */

export interface VisionFailureContext {
  /** Provider label, for the message. */
  label: string;
  model: string;
  endpoint: string;
  localRuntime: boolean;
}

/** Endpoint answers that mean "I took your request but not your image". */
const IMAGE_REJECTED_PATTERNS = [
  /does not support (image|vision|multimodal)/i,
  /image input (is )?(not|un)supported/i,
  /no (vision|multimodal|image) (support|capability)/i,
  /unsupported content type/i,
  /invalid content type.*image/i,
  /mmproj|multimodal projector|projector/i,
  /vision (model|adapter) (not|un)(loaded|available)/i,
  /unknown field.*image/i,
  /content parts? .*not supported/i,
];

/** Answers that mean the endpoint was never reached at all. */
const UNREACHABLE_PATTERNS = [
  /timed out|timeout|ETIMEDOUT/i,
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNRESET/i,
  /fetch failed|network|socket hang up/i,
];

const messageOf = (error: unknown): string =>
  error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);

export function classifyVisionFailure(
  error: unknown,
  context: VisionFailureContext,
): VisionUnavailableError {
  // An already-classified failure passes through: the adapter knows more than
  // this function can infer from a string.
  if (error instanceof VisionUnavailableError) return error;

  const message = messageOf(error);
  const status = extractStatus(error) ?? extractStatus((error as { cause?: unknown })?.cause);

  if (UNREACHABLE_PATTERNS.some((pattern) => pattern.test(message))) {
    return new VisionUnavailableError(
      'unreachable',
      `the vision endpoint at ${context.endpoint} did not answer (${message.trim()}), check that ` +
        `the runtime is up and reachable from this container`,
      error,
    );
  }

  if (status === 401 || status === 403) {
    return new VisionUnavailableError(
      'unreachable',
      `the vision endpoint at ${context.endpoint} rejected our credentials (HTTP ${status})`,
      error,
    );
  }

  // A 4xx that is not auth or rate limiting means the endpoint understood the
  // request and refused it, and an image request refused is an image refused.
  const clientRefusal = status !== undefined && status >= 400 && status < 500 && status !== 429;
  if (clientRefusal || IMAGE_REJECTED_PATTERNS.some((pattern) => pattern.test(message))) {
    return new VisionUnavailableError(
      'image_rejected',
      context.localRuntime
        ? `the model "${context.model}" on the local runtime at ${context.endpoint} refused image ` +
            `input. A GGUF model is multimodal only when its MULTIMODAL PROJECTOR is loaded with ` +
            `it: the same weights serve happily as a text-only model, and neither the model name ` +
            `nor \`ollama list\` shows the difference. Check that the model was pulled or built ` +
            `with its mmproj file (a vision build of the same model, or a Modelfile naming it), ` +
            `or point COGETO_MODEL_VISION at a model that has one. Upstream said: ${message.trim()}`
        : `the model "${context.model}" on ${context.label} refused image input: it is probably ` +
            `not a vision model, or this endpoint does not accept image content parts. Upstream ` +
            `said: ${message.trim()}`,
      error,
    );
  }

  // Anything left (5xx, a malformed body, an unrecognised transport error) is
  // the endpoint failing to give us something usable.
  return new VisionUnavailableError(
    'unusable_response',
    `the vision model "${context.model}" on ${context.label} did not return a usable answer ` +
      `(${message.trim()})`,
    error,
  );
}
