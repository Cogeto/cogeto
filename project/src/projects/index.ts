/**
 * projects — workspaces over one shared memory (V2.5 item 8.3).
 *
 * Projects organize conversations, sources, research runs, connector
 * sub-scopes and reports, and can NARROW retrieval. They never decide
 * visibility: the scope and sensitive gates are the memory module's and are
 * untouched by this module. Decision record: docs/features/projects.md.
 */
export {
  ProjectsModule,
  ProjectAssignmentCascade,
  ProjectAssignmentCascadeModule,
} from './projects.module';
export { ProjectService, toProjectDto } from './project.service';
export type { ProjectLens } from './project.service';
export { ProjectStore } from './persistence/project.store';
export type { AssignmentRef, SourceRef } from './persistence/project.store';
export type { ProjectRow, ProjectAssignmentRow } from './persistence/tables';
export { LENS_SOURCE_CAP } from './project-lens';
export { ProjectPolicySource, ProjectPolicyModule } from './project-policy.adapter';
