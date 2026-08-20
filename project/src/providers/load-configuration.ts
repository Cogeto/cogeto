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
    /** Structural, so pino (the entrypoints) and Nest loggers both fit. */
    logger?: { error(message: string): void };
  },
): Promise<ResolvedModelProviders> {
  const store = new ProviderStore(db);
  // The version is read BEFORE the data, never beside it. A configuration
  // write (the rebuild's switch above all) commits data and version bump in
  // one transaction, but these reads are not one snapshot: read in parallel,
  // a resolve straddling the commit can pair PRE-switch data with the
  // POST-switch version number, and the version poller then believes that
  // stale content is current forever. Version-first makes the same tear
  // carry an old number with new data, which the next poll heals.
  const version = await store.readVersion();
  const [providers, assignments, answerOptions] = await Promise.all([
    store.listProvidersWithSecrets(),
    store.listAssignments(),
    store.listAnswerOptions(),
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
