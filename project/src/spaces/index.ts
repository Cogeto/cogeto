/**
 * Public interface of the spaces module (docs/features/spaces.md). A barrel
 * never re-exports a live table.
 */
export { SpacesModule } from './spaces.module';
export { SpaceService } from './space.service';
export { SpaceNameModule, SpaceNameSource } from './space-name.adapter';
export type { SpaceRow, UserSpaceStateRow } from './persistence/tables';
