import type { ResolvedModelProviders } from './provider-config';

/**
 * Boot-time probe of the local Ollama runtime (decision 0041 ruling 2):
 * misconfiguration fails loudly at startup, never at first request. When any
 * tier resolves to the local provider, the app, worker, and reindex
 * entrypoints call this before serving — an unreachable runtime or a model
 * that was never pulled refuses boot with the exact fix.
 */

interface TagsResponse {
  models?: { name?: string; model?: string }[];
}

/** `bge-m3` matches the tag `bge-m3:latest`; a tagged name must match exactly. */
export function modelAvailable(required: string, tags: string[]): boolean {
  return tags.some(
    (tag) => tag === required || (!required.includes(':') && tag.split(':')[0] === required),
  );
}

export async function assertLocalRuntimeReady(
  providers: ResolvedModelProviders,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  if (!providers.configured || !providers.ollama) return;
  const { baseUrl } = providers.ollama;
  const required = [
    ...new Set(
      (['pipeline', 'answer', 'embedding'] as const)
        .filter((tier) => providers.tiers[tier].provider === 'ollama')
        .map((tier) => providers.tiers[tier].model),
    ),
  ];

  let tags: string[];
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as TagsResponse;
    tags = (body.models ?? [])
      .map((model) => model.name ?? model.model ?? '')
      .filter((name) => name.length > 0);
  } catch (error) {
    throw new Error(
      `Ollama runtime unreachable at ${baseUrl} ` +
        `(${error instanceof Error ? error.message : String(error)}) — check that the runtime is ` +
        `up and that this container can reach the address in COGETO_OLLAMA_BASE_URL ` +
        `(decision 0041 ruling 2), then start again.`,
      { cause: error },
    );
  }

  const missing = required.filter((model) => !modelAvailable(model, tags));
  if (missing.length > 0) {
    throw new Error(
      missing
        .map(
          (model) =>
            `model "${model}" is not available on the Ollama runtime at ${baseUrl} — ` +
            `run \`ollama pull ${model}\` on the Ollama host`,
        )
        .join('; ') + `, then start again.`,
    );
  }
}
