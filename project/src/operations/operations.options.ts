import type { ResolvedModelProviders } from '../model-gateway/index';

/**
 * What the operations context needs to know about the instance it reports on
 * (V2.0 item 3.6 part 2).
 *
 * These surfaces used to inject the whole `CogetoConfig` from `entrypoints/`,
 * which is exactly the dependency the module graph forbids: nothing may import
 * a composition root. So the module declares the fields it actually reads and
 * the app root maps its config onto them, the same way `MemoryModule`,
 * `ConnectorsModule` and `PassportModule` already take options.
 *
 * Writing them out is the point. This list IS the answer to "what does the
 * health and capability surface know about this deployment", which was
 * previously "all of it".
 */
export interface OperationsOptions {
  /** Probed for readiness by the health report. */
  qdrantUrl: string;
  s3Url: string;
  /** `host:port` of the inbound SMTP listener; unset when mail is not configured. */
  mailSmtpAddress?: string;
  /** The role that unlocks the health report's operational detail (SEC-3). */
  adminRole: string;

  // ── Capability registry inputs ────────────────────────────────────────────
  /** COGETO_PRODUCTION: a production instance never advertises the sandbox. */
  production: boolean;
  demoMode: boolean;
  consolesEnabled: boolean;
  redactionEnabled: boolean;
  redactionUrl?: string;
  researchEnabled: boolean;
  searxngUrl?: string;
  mailEnabled: boolean;
  /** The compose profiles this process was started with (the container cannot
   * see them itself; COGETO_COMPOSE_PROFILES mirrors them in). */
  composeProfiles: string[];
  /** Hours after which a scheduled job counts as overdue. */
  jobsOverdueHours: number;
  /** The resolved provider configuration, for the local-runtime probe. */
  modelProviders: ResolvedModelProviders;
  /** Deadline for the vision probe; the same one the reading ladder uses. */
  visionProbeTimeoutMs?: number;
}

export const OPERATIONS_OPTIONS = Symbol('OPERATIONS_OPTIONS');
