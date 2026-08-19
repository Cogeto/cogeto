/**
 * Public interface of the spaces module (docs/features/spaces.md). A barrel
 * never re-exports a live table.
 */
export { SpacesModule } from './spaces.module';
export { SpaceService } from './space.service';
export { SpaceNameModule, SpaceNameSource } from './space-name.adapter';
export {
  SpaceErasureService,
  SPACE_ERASE_JOB_TYPE,
  SPACE_ERASE_SOURCE_TYPE,
} from './space-erasure.service';
export type { SpaceDeletionPlan, SpaceErasureResult } from './space-erasure.service';
export { SPACE_CLEANUPS } from './space-cleanup.port';
export type { SpaceCleanup } from './space-cleanup.port';
export type { SpaceRow, UserSpaceStateRow } from './persistence/tables';
