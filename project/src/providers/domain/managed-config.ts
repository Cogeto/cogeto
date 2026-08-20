import { z } from 'zod';

/**
 * The managed provider's configuration contract (hosted provisioning, task A).
 *
 * A hosting platform renders one JSON file per instance and supplies its path
 * via `COGETO_MANAGED_PROVIDER_FILE`; the API key arrives separately in
 * `COGETO_MANAGED_PROVIDER_API_KEY` and appears in NEITHER file. The committed
 * template (`project/infra/managed-provider.example.json`) documents the shape
 * with placeholders only.
 *
 * The rules are deliberately strict, because the reconciler acts on this at
 * boot with nobody watching: a malformed file refuses the boot with a message
 * naming precisely what is wrong. Never guess, never partially apply.
 */

export class ManagedProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedProviderConfigError';
  }
}

const servedName = z.string().min(1).max(200);

const managedFileSchema = z
  .object({
    label: z.string().min(1).max(120),
    // The platform contract spells it without the underscore; the stored
    // provider type is the repo's `self_hosted`. Both spellings are accepted
    // so neither side can be broken by the other's convention.
    type: z.enum(['selfhosted', 'self_hosted']),
    base_url: z.url(),
    models: z.record(servedName, z.string().min(1).max(200)),
    assign: z.object({
      pipeline: servedName,
      answer: servedName,
      embeddings: servedName,
      vision: servedName.optional(),
    }),
    answer_options: z.array(servedName).default([]),
  })
  .superRefine((value, ctx) => {
    const served = Object.keys(value.models);
    if (served.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['models'], message: 'must map at least one model' });
    }
    const parsed = (() => {
      try {
        return new URL(value.base_url);
      } catch {
        return null;
      }
    })();
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      ctx.addIssue({
        code: 'custom',
        path: ['base_url'],
        message: 'must be an http or https URL',
      });
    }
    for (const [tier, name] of Object.entries(value.assign)) {
      if (name !== undefined && !served.includes(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['assign', tier],
          message: `"${name}" is not one of the served models`,
        });
      }
    }
    value.answer_options.forEach((name, index) => {
      if (!served.includes(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['answer_options', index],
          message: `"${name}" is not one of the served models`,
        });
      }
    });
  });

/** The validated contract, in the repo's own vocabulary. */
export interface ManagedProviderConfig {
  label: string;
  type: 'self_hosted';
  baseUrl: string;
  /** Served name to upstream identifier. The served names are the ONLY models
   * the managed provider offers. */
  models: Record<string, string>;
  assign: { pipeline: string; answer: string; embeddings: string; vision?: string };
  answerOptions: string[];
}

/**
 * Parse and validate the platform-rendered file. Failures name the field, and
 * only the field: no raw file content in the message, because a rendered file
 * can carry values that do not belong in a log.
 */
export function parseManagedProviderConfig(raw: string, source: string): ManagedProviderConfig {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ManagedProviderConfigError(
      `the managed provider configuration at ${source} is not valid JSON`,
    );
  }
  const parsed = managedFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ManagedProviderConfigError(
      `the managed provider configuration at ${source} is invalid: ${issues}`,
    );
  }
  const value = parsed.data;
  return {
    label: value.label.trim(),
    type: 'self_hosted',
    baseUrl: value.base_url.replace(/\/+$/, ''),
    models: value.models,
    assign: value.assign,
    answerOptions: value.answer_options,
  };
}

/**
 * The upstream identity behind a served name under a given map: the map's
 * answer, or the name itself where no mapping exists. Used ONLY to compare two
 * maps for the embeddings geometry rule; it never feeds a request, a message
 * or anything stored.
 */
export function upstreamIdentityOf(
  aliases: Record<string, string> | null | undefined,
  served: string,
): string {
  return aliases?.[served] ?? served;
}
