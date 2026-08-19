/**
 * Port for resolving a space's display name (docs/features/spaces.md section
 * 6c): the report's scope block states the space it describes, but the space
 * table belongs to the spaces module, so the reports module defines the need
 * and the composition root binds the implementation (the passport's
 * SpaceNameResolver, verbatim in kind). Optional at the injection site: a
 * harness without the binding states `space_name: null`, and the space id
 * remains the durable identity either way.
 */
export interface ReportSpaceNameResolver {
  nameOf(spaceId: string): Promise<string | null>;
}

export const REPORT_SPACE_NAMES = Symbol('REPORT_SPACE_NAMES');
