import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveModelProviders } from '../model-gateway/index';
import type { ResolvedModelProviders } from '../model-gateway/index';
import { redactionFromEnv } from './config';

/**
 * Eval-harness provider resolution (decision 0040 ruling 5): the SAME resolver
 * the instance boots with, over process.env plus a repo-root `.env` fallback
 * for the key/config variables (the historical convenience for local runs).
 * Whatever configuration this returns is EXACTLY what `--emit-json` records.
 */
export async function resolveEvalProviders(repoRoot: string): Promise<{
  providers: ResolvedModelProviders;
  redaction: { enabled: boolean; url: string } | undefined;
}> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  try {
    const dotenv = await readFile(path.join(repoRoot, '.env'), 'utf8');
    for (const line of dotenv.split('\n')) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !env[match[1]!]) env[match[1]!] = match[2]!.trim();
    }
  } catch {
    // No repo .env — process env alone decides.
  }
  const redaction = redactionFromEnv();
  const providers = resolveModelProviders(env, { redacted: redaction !== undefined });
  return { providers, redaction };
}

export function requireConfiguredProviders(
  providers: ResolvedModelProviders,
  harness: string,
): void {
  if (!providers.configured) {
    console.error(
      `${harness} needs a configured model provider — set COGETO_MISTRAL_API_KEY or a ` +
        `COGETO_PROVIDER_* configuration (env or repo-root .env); the harness is live-only`,
    );
    process.exit(2);
  }
}
