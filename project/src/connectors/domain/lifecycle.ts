/**
 * The connector lifecycle (V2.5 item 8.1, issue A): eight states every
 * connector shares, transitions owned here as a pure function so the state
 * machine is unit-testable without a database and no store can invent a
 * transition the decision record does not name.
 */

export const CONNECTOR_STATES = [
  'configured',
  'authorised',
  'syncing',
  'healthy',
  'degraded',
  'needs_reauth',
  'disabled',
  'removed',
] as const;

export type ConnectorState = (typeof CONNECTOR_STATES)[number];

/** States in which the sync engine will run a pass at all. */
export const SYNCABLE_STATES: readonly ConnectorState[] = [
  'authorised',
  'syncing',
  'healthy',
  'degraded',
];

const TRANSITIONS: Record<ConnectorState, readonly ConnectorState[]> = {
  // Credentials arrive, or the connector is removed unauthorised.
  configured: ['authorised', 'removed'],
  // First sync starts, the user pauses it, auth breaks, or it is removed.
  authorised: ['syncing', 'disabled', 'needs_reauth', 'removed'],
  // A pass settles healthy or degraded, auth breaks mid-sync, the user
  // pauses, or the connector is removed mid-sync.
  syncing: ['healthy', 'degraded', 'needs_reauth', 'disabled', 'removed'],
  healthy: ['syncing', 'degraded', 'needs_reauth', 'disabled', 'removed'],
  // Recovery is a successful pass; reauthorisation replaces the credential.
  degraded: ['syncing', 'healthy', 'needs_reauth', 'disabled', 'removed'],
  // Only a fresh credential (back to authorised) or removal leaves here:
  // the refresh loop never retries forever into this state.
  needs_reauth: ['authorised', 'disabled', 'removed'],
  disabled: ['authorised', 'syncing', 'removed'],
  // Terminal. Credentials destroyed, sync state cleared, sources remain.
  removed: [],
};

export function canTransition(from: ConnectorState, to: ConnectorState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The transition, or an explanation the caller turns into a 409. */
export function transition(
  from: ConnectorState,
  to: ConnectorState,
): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: true };
  if (canTransition(from, to)) return { ok: true };
  return { ok: false, reason: `a ${from} connector cannot become ${to}` };
}
