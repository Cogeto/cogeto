/**
 * Port for resolving a space's display name (docs/features/spaces.md): the
 * manifest of a per-space passport names the space it exports, but the space
 * table belongs to the spaces module, so the passport module defines the
 * need and the composition root binds the implementation (the SourceDeletion
 * precedent, spec §15 rule 2). Optional at the injection site: a harness
 * without the binding exports `name: null`, and the space id remains the
 * durable identity either way.
 */
export interface SpaceNameResolver {
  nameOf(spaceId: string): Promise<string | null>;
}

export const SPACE_NAME_RESOLVER = Symbol('SPACE_NAME_RESOLVER');
