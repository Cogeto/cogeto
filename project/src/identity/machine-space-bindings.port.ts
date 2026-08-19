/**
 * Port for resolving a MACHINE caller's per-credential space binding
 * (docs/features/spaces.md section 6c). A machine principal (a token without
 * a human profile) has no current space and no "most recent" anything, so
 * its space is a property of the credential's identity: bound by an
 * administrator, one space per machine user. The binding rows belong to the
 * spaces module; the identity seam defines the need and the composition
 * roots bind the implementation (the SpaceNameResolver precedent, spec §15
 * rule 2).
 *
 * FAIL CLOSED at the injection site: a root without the binding refuses
 * every machine principal, because an unresolvable space must never default
 * quietly.
 */
export interface MachineSpaceBindings {
  /** The space bound to this machine user, or null when unbound. */
  spaceFor(userId: string): Promise<string | null>;
}

export const MACHINE_SPACE_BINDINGS = Symbol('MACHINE_SPACE_BINDINGS');
