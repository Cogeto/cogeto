import { Logger } from '@nestjs/common';
import { ProviderStore } from './persistence/provider-store';
import { resolveFromRecords } from './domain/resolve';
import type { Db } from '../infrastructure/index';
import type { ResolvedModelProviders } from '../model-gateway/index';

/**
 * The boot path for model configuration.
 *
 * Every process that talks to a model calls this once, before it builds
 * anything: resolve what the instance actually runs from the DATABASE. The
 * result is what the gateway, the boot log, the capability registry and the
 * trust-score emission all read, so they cannot disagree about which
 * configuration is active.
 *
 * The database is the ONLY source. There is no environment fallback and no
 * seeding: model providers are created and assigned in the interface, and an
 * instance with none configured boots cleanly with model features off — the
 * normal first-run state, not an error.
 */
export async function loadModelConfiguration(
  db: Db,
  input: {
    masterKey: Buffer | null;
    redacted: boolean;
    reasoningHeadroom: number;
    timeoutsMs: ResolvedModelProviders['timeoutsMs'];
    logger?: Logger;
  },
): Promise<ResolvedModelProviders> {
  const store = new ProviderStore(db);
  const [providers, assignments, answerOptions, version] = await Promise.all([
    store.listProvidersWithSecrets(),
    store.listAssignments(),
    store.listAnswerOptions(),
    store.readVersion(),
  ]);
  return resolveFromRecords({
    // A provider whose key cannot be opened is skipped, not fatal: the
    // instance boots with model features off and an admin can re-enter the
    // key, which is impossible if the app refuses to start.
    onUnreadable: (provider) =>
      input.logger?.error(
        `provider "${provider.label}" is unusable: ${provider.reason} ` +
          `(its tiers are unconfigured until the key is re-entered)`,
      ),
    providers,
    assignments,
    answerOptions,
    version,
    masterKey: input.masterKey,
    redacted: input.redacted,
    reasoningHeadroom: input.reasoningHeadroom,
    timeoutsMs: input.timeoutsMs,
  });
}
