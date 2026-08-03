import { crc32, deflateSync } from 'node:zlib';
import { VisionUnavailableError } from './errors';
import type { VisionUnavailableReason } from './errors';
import type { ModelGateway } from './model-gateway.service';
import type { ResolvedModelProviders } from './provider-config';

/**
 * The vision probe (V2.1 item 4.1): does THIS configuration actually read
 * images?
 *
 * The answer cannot be read off a model name, a provider name, or a
 * configuration flag, and this is not a theoretical objection. A GGUF model is
 * multimodal only when its multimodal projector is loaded beside the weights;
 * the identical weights are served either way, `ollama list` shows the same
 * line for both, and the failure appears only when an image is actually sent.
 * Hosted providers differ too, and a model that took images last month can stop
 * doing so under a renamed alias.
 *
 * So the probe sends a REAL image through the real gateway, decorators and all,
 * and classifies what comes back. It is the only way to answer the question
 * honestly, and it is cheap: a 32-pixel PNG and a one-word instruction.
 */

export interface VisionProbeResult {
  ok: boolean;
  /** Present on success: what the configuration is and that it answered. */
  detail?: string;
  /** Present on failure: the operator-actionable message. */
  error?: string;
  /** Present on failure: which of the four cases this was. */
  reason?: VisionUnavailableReason;
}

/** The instruction: trivial for any model that can see, impossible for one that cannot. */
const PROBE_INSTRUCTION =
  'Answer in one short sentence: what do you see in this image? ' +
  'Describe only what is visible.';

/**
 * A 32x32 solid-colour PNG, built here rather than committed as a fixture so
 * the probe has no file to lose and nothing to read from disk at boot.
 *
 * Deliberately trivial: the probe asks whether the configuration ACCEPTS and
 * ANSWERS about an image, not whether it reads well. Judging quality here would
 * make a small local model look broken when it is merely small, and the reading
 * ladder already scores real output on real pages.
 */
export function probeImagePng(): Buffer {
  const size = 32;
  // One filter byte (0 = none) per row, then RGB triples. A single flat colour
  // compresses to almost nothing and is unambiguous to describe.
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (1 + size * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const at = rowStart + 1 + x * 3;
      // A blue square with a lighter band across the middle, so a model has
      // something to say beyond one word.
      const band = y > size / 3 && y < (size * 2) / 3;
      raw[at] = band ? 0xf0 : 0x20;
      raw[at + 1] = band ? 0xf0 : 0x40;
      raw[at + 2] = band ? 0xf0 : 0xc0;
    }
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0, 0);
    return Buffer.concat([length, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const PROBE_IMAGE_MEDIA_TYPE = 'image/png';

/**
 * Probes the configured vision tier. Returns null when the instance declares no
 * vision binding at all AND the caller wants that treated as "nothing to
 * probe"; by default a missing binding is reported as an honest unavailable,
 * because the capability panel must say why.
 */
export async function probeVision(
  gateway: ModelGateway,
  providers: ResolvedModelProviders | undefined,
  options: { timeoutMs?: number } = {},
): Promise<VisionProbeResult> {
  if (!providers?.configured) {
    return {
      ok: false,
      reason: 'not_configured',
      error: 'the model gateway is not configured, so there is no vision tier to probe',
    };
  }
  if (!providers.vision) {
    return {
      ok: false,
      reason: 'not_configured',
      error:
        'no vision tier is configured: set COGETO_PROVIDER_VISION and COGETO_MODEL_VISION to ' +
        'read scanned pages, images and diagrams. Without it the reading ladder stops at OCR ' +
        'and pages that need vision are labelled as such rather than silently empty.',
    };
  }

  const binding = `${providers.vision.provider}/${providers.vision.model}`;
  try {
    const result = await withTimeout(
      gateway.describeImage({
        input: PROBE_INSTRUCTION,
        image: { bytes: probeImagePng(), mediaType: PROBE_IMAGE_MEDIA_TYPE },
        maxTokens: 64,
      }),
      options.timeoutMs,
      binding,
    );
    if (result.text.trim().length === 0) {
      return {
        ok: false,
        reason: 'unusable_response',
        error: `the vision model ${binding} accepted the probe image and answered with nothing`,
      };
    }
    return { ok: true, detail: `vision available on ${binding}; the probe image was read` };
  } catch (error) {
    if (error instanceof VisionUnavailableError) {
      return { ok: false, reason: error.reason, error: error.message };
    }
    return {
      ok: false,
      reason: 'unusable_response',
      error:
        `the vision probe against ${binding} failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The probe gets its own short deadline. The tier's own timeout is sized for a
 * full page and is minutes long on a local runtime; a boot check and a
 * capability poll must not sit behind that.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number | undefined, binding: string) {
  if (timeoutMs === undefined) return work;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new VisionUnavailableError(
            'unreachable',
            `the vision probe against ${binding} did not answer within ${timeoutMs} ms`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
