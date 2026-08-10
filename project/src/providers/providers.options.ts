import type { LiveModelConfiguration, ResolvedModelProviders } from '../model-gateway/index';

/**
 * What the providers module needs from its composition root (V2.4 item 7.1).
 *
 * Every field here is a deployment fact the module may not read for itself: a
 * domain module never reads the environment (AGENTS.md, spec §12), and the
 * master key in particular must arrive as one value from one place rather than
 * be picked up wherever it is convenient.
 */
export const PROVIDERS_OPTIONS = Symbol('PROVIDERS_OPTIONS');

export interface ProvidersOptions {
  /**
   * The live configuration this module keeps up to date. The SAME object the
   * gateway routes through and every other consumer holds, so a saved
   * assignment reaches all of them without a restart.
   */
  live: LiveModelConfiguration;
  /**
   * The instance master key, or null when the environment has none. Null is
   * fine until something needs encrypting, and then the failure names the
   * variable and the command that generates it.
   */
  masterKey: Buffer | null;
  /** Redaction stays an environment fact: it is a deployment profile. */
  redacted: boolean;
  reasoningHeadroom: number;
  timeoutsMs: ResolvedModelProviders['timeoutsMs'];
  /** Where the published trust-score artifacts live, for the "not evaluated" mark. */
  trustScoresDir: string;
  /**
   * How often a process asks whether another one changed the configuration.
   * The app also reloads immediately on its own writes, so this is what makes
   * the WORKER current; 0 disables it (tests, bare harnesses).
   */
  pollIntervalMs: number;
}
