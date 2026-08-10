import { Logger } from '@nestjs/common';
import { ProviderStore } from './persistence/provider-store';
import { resolveFromRecords } from './domain/resolve';
import { seedFromEnvironment } from './domain/seed';
import type { Db } from '../infrastructure/index';
import type { ResolvedModelProviders } from '../model-gateway/index';

/**
 * The boot path for model configuration (V2.4 item 7.1).
 *
 * Every process that talks to a model calls this once, before it builds
 * anything: seed the environment in if this is the first start after the
 * upgrade, then resolve what the instance actually runs. The result is what the
 * gateway, the boot log, the capability registry and the trust-score emission
 * all read, so they cannot disagree about which configuration is active — the
 * same property the single environment resolver gave them before.
 *
 * **After seeding, the environment's model variables are ignored.** Not
 * deprecated, not a fallback, not a lower-priority override: ignored. They can
 * sit in `.env` forever and change nothing, which is why the upgrade note says
 * they may simply be deleted. Two sources of truth for one setting is how an
 * instance ends up running a model nobody selected.
 */

export interface LoadedModelConfiguration {
  providers: ResolvedModelProviders;
  /** True when this call performed the one-time seed. */
  seeded: boolean;
  seededProviders: number;
}

export async function loadModelConfiguration(
  db: Db,
  input: {
    /** The environment's resolution — the seed source, and nothing after that. */
    environment: ResolvedModelProviders;
    masterKey: Buffer | null;
    redacted: boolean;
    reasoningHeadroom: number;
    timeoutsMs: ResolvedModelProviders['timeoutsMs'];
    logger?: Logger;
  },
): Promise<LoadedModelConfiguration> {
  const store = new ProviderStore(db);
  const seed = await seedFromEnvironment(store, input.environment, input.masterKey);
  if (seed.seeded && seed.providers > 0) {
    input.logger?.log(
      `model configuration seeded from the environment: ${seed.providers} provider(s), ` +
        `${seed.assignments} assignment(s). The environment's model variables are ignored ` +
        `from now on and may be removed.`,
    );
  }

  const [providers, assignments, answerOptions, state] = await Promise.all([
    store.listProvidersWithSecrets(),
    store.listAssignments(),
    store.listAnswerOptions(),
    store.readState(),
  ]);
  return {
    providers: resolveFromRecords({
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
      version: state.version,
      masterKey: input.masterKey,
      redacted: input.redacted,
      reasoningHeadroom: input.reasoningHeadroom,
      timeoutsMs: input.timeoutsMs,
    }),
    seeded: seed.seeded,
    seededProviders: seed.providers,
  };
}
