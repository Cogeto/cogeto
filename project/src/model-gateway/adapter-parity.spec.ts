import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_PROVIDER_IDS, VISION_CAPABLE } from './provider-config';

/**
 * adapter_parity (issue #574): a capability may not land in one adapter and go
 * missing from the others by accident.
 *
 * Three defects in a row had exactly this shape, and each was reported so far
 * from its cause that the message misdirected whoever read it:
 *
 *   - vision existed only in the OpenAI-compatible adapter, so a Mistral
 *     assignment reported that the INSTANCE had no vision tier (#570);
 *   - the capability was still offered for providers that could never serve
 *     it, because nothing tied the interface's table to the adapters (#571);
 *   - the thinking channel existed only in the OpenAI and Anthropic adapters,
 *     so a Magistral model answered without deliberating and the reasoning
 *     capability probed `off` whatever the model was (#573).
 *
 * These are source-level assertions, which is crude on purpose. The property
 * is "every adapter accounts for every optional capability", and the only way
 * to be sure is to look at every adapter. An adapter that genuinely cannot
 * serve a capability is not blocked here: it is RECORDED below, next to the
 * reason, which is the difference between a decision and an oversight.
 */

const DIR = path.join(process.cwd(), 'model-gateway');
const source = (file: string): string => readFileSync(path.join(DIR, file), 'utf8');

/** Every concrete provider adapter, and the provider ids it serves. */
const ADAPTERS = [
  { file: 'mistral.gateway.ts', serves: ['mistral'] },
  { file: 'openai.gateway.ts', serves: ['openai', 'ollama'] },
  { file: 'anthropic.gateway.ts', serves: ['anthropic'] },
] as const;

/**
 * Adapters that deliberately do NOT implement a capability, and why. An entry
 * here is a decision on the record; its absence is what makes the assertions
 * below bite.
 */
const RECORDED_GAPS: Record<string, Record<string, string>> = {
  'anthropic.gateway.ts': {
    vision:
      'no image path in this adapter. The models are multimodal, so this is a gap in our code, ' +
      'not in the vendor, and PROVIDER_TYPE_SPECS.anthropic.supportsVision is false to match: ' +
      'the interface offers what the instance can do (issue #571).',
    embeddings: 'Anthropic publishes no embeddings API at all (0040 ruling 3).',
  },
  'mistral.gateway.ts': {
    thinkingControl:
      'a hosted vendor API, not a server we control: `chat_template_kwargs` is a llama.cpp-family ' +
      'flag and the hosted API rejects unknown parameters. Magistral deliberates by default, so ' +
      'there is nothing to switch on.',
  },
};

const gapFor = (file: string, capability: string): string | undefined =>
  RECORDED_GAPS[file]?.[capability];

describe('adapter_parity: optional capabilities are accounted for in every adapter', () => {
  it('every adapter surfaces the thinking CHANNEL, or records why it cannot', () => {
    // Reasoning is a channel, not content: an adapter that never yields the
    // channel makes the capability unreportable and the chat toggle inert,
    // whatever model is bound (#573).
    for (const { file } of ADAPTERS) {
      const text = source(file);
      const gap = gapFor(file, 'reasoning');
      if (gap) continue;
      expect(text, `${file} never yields the thinking channel (issue #573)`).toContain(
        "channel: 'thinking'",
      );
      expect(text, `${file} never yields the text channel`).toContain("channel: 'text'");
    }
  });

  it('every adapter that can reason reports it on the non-streaming path too', () => {
    // `probeReasoning` reads `reasoned` off a `complete()` result, so an
    // adapter that only tags the stream leaves the capability probing off.
    for (const { file } of ADAPTERS) {
      if (gapFor(file, 'reasoning')) continue;
      const text = source(file);
      if (!text.includes("channel: 'thinking'")) continue;
      // Anthropic's extended thinking must be REQUESTED, so an unasked model
      // never reasons and `reasoned` staying unset is the truth, not a gap.
      if (file === 'anthropic.gateway.ts') continue;
      expect(text, `${file} yields thinking but never sets \`reasoned\` (issue #573)`).toMatch(
        /reasoned/,
      );
    }
  });

  it('every vision-capable provider id has an adapter that implements describeImage', () => {
    // The inverse of #570: a provider id in VISION_CAPABLE whose adapter never
    // overrides describeImage inherits the base refusal, which reports the
    // INSTANCE unconfigured on an instance that is configured.
    for (const providerId of VISION_CAPABLE) {
      const adapter = ADAPTERS.find((entry) =>
        (entry.serves as readonly string[]).includes(providerId),
      );
      expect(adapter, `no adapter serves the vision-capable provider "${providerId}"`).toBeTruthy();
      expect(
        source(adapter!.file),
        `${providerId} is VISION_CAPABLE but ${adapter!.file} has no describeImage (issue #570)`,
      ).toMatch(/override async describeImage/);
    }
  });

  it('an adapter that does NOT implement describeImage is recorded, not merely silent', () => {
    for (const { file } of ADAPTERS) {
      if (source(file).includes('override async describeImage')) continue;
      expect(
        gapFor(file, 'vision'),
        `${file} has no describeImage and no recorded reason: add one to RECORDED_GAPS ` +
          `so the omission is a decision`,
      ).toBeTruthy();
    }
  });

  it('every provider id the gateway knows is served by exactly one adapter', () => {
    // Keeps the table above honest as adapters are added: an unserved id would
    // make every assertion here vacuously pass for it.
    for (const providerId of MODEL_PROVIDER_IDS) {
      const serving = ADAPTERS.filter((entry) =>
        (entry.serves as readonly string[]).includes(providerId),
      );
      expect(
        serving.length,
        `provider "${providerId}" is served by ${serving.length} adapters`,
      ).toBe(1);
    }
  });
});
