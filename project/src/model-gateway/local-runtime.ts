import type { ResolvedModelProviders } from './provider-config';

/**
 * Boot-time probe of the local Ollama runtime (decision 0041 ruling 2):
 * misconfiguration fails loudly at startup, never at first request. When any
 * tier resolves to the local provider, the app, worker, and reindex
 * entrypoints call this before serving — an unreachable runtime or a model
 * that was never pulled refuses boot with the exact fix.
 *
 * The probe itself is shared with the capability registry (P6.7, decision
 * 0055): `probeLocalRuntime` reports instead of throwing, so /api/health can
 * show a runtime that died AFTER a successful boot without duplicating this
 * logic.
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

export interface LocalRuntimeProbe {
  ok: boolean;
  /** Present on success, e.g. "runtime reachable, 2 required model(s) present". */
  detail?: string;
  /** Present on failure — the same operator-actionable message the boot guard throws. */
  error?: string;
}

/**
 * Probe the configured Ollama runtime: reachability of `<base>/api/tags` plus
 * availability of every model a tier is bound to. Returns null when no tier
 * resolves to the local provider (nothing to probe).
 */
export async function probeLocalRuntime(
  providers: ResolvedModelProviders,
  options: { timeoutMs?: number } = {},
): Promise<LocalRuntimeProbe | null> {
  if (!providers.configured || !providers.ollama) return null;
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
    return {
      ok: false,
      error:
        `Ollama runtime unreachable at ${baseUrl} ` +
        `(${error instanceof Error ? error.message : String(error)}) — check that the runtime is ` +
        `up and that this container can reach the address in COGETO_OLLAMA_BASE_URL ` +
        `(decision 0041 ruling 2), then start again.`,
    };
  }

  const missing = required.filter((model) => !modelAvailable(model, tags));
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        missing
          .map(
            (model) =>
              `model "${model}" is not available on the Ollama runtime at ${baseUrl} — ` +
              `run \`ollama pull ${model}\` on the Ollama host`,
          )
          .join('; ') + `, then start again.`,
    };
  }
  return {
    ok: true,
    detail: `runtime reachable at ${baseUrl}, ${required.length} required model(s) present`,
  };
}

export async function assertLocalRuntimeReady(
  providers: ResolvedModelProviders,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const probe = await probeLocalRuntime(providers, options);
  if (probe && !probe.ok) throw new Error(probe.error);
}
