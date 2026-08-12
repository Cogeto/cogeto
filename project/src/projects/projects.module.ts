import { Injectable, Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import type { Tx } from '../infrastructure/index';
import type { DerivedCascade } from '../memory/index';
import { ProjectStore } from './persistence/project.store';
import { ProjectService } from './project.service';
import { ProjectsController } from './projects.controller';

/**
 * projects — workspaces over one shared memory (V2.5 item 8.3).
 *
 * A leaf domain context: it owns `project` + `project_assignment` and imports
 * no other domain module, which is what lets everything that needs an
 * assignment (chat, files, connectors, research, reports, sources) import IT
 * without a cycle. It decides nothing about visibility; the gates stay the
 * memory module's. Decision record: docs/features/projects.md.
 */
@Module({})
export class ProjectsModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: ProjectsModule,
      imports: [...(options.imports ?? [])],
      controllers: [ProjectsController],
      providers: [ProjectStore, ProjectService],
      exports: [ProjectStore, ProjectService],
    };
  }

  /**
   * The worker slice: the store and the service without the controller. The
   * connector sync engine and the report assembler both need assignments, and
   * neither serves a route.
   */
  static forWorker(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: ProjectsModule,
      imports: [...(options.imports ?? [])],
      providers: [ProjectStore, ProjectService],
      exports: [ProjectStore, ProjectService],
    };
  }
}

/**
 * Deletion coverage (V2.5 item 8.3 issue D3), and the finding it rests on:
 * **project rows carry no source-derived content.** A name, a description and
 * a colour are the user's own words and choices; an assignment row is
 * identifiers and a kind. There is therefore nothing here for a receipt to
 * promise erased.
 *
 * What there IS is stale state: an assignment pointing at a source that no
 * longer exists. This releases it inside the saga's enumeration transaction
 * and reports the count, so erasing a source takes it out of its project as
 * part of the same signed act. `cascadeForMemories` returns 0 because
 * assignments key on containers, never on memories.
 */
@Injectable()
export class ProjectAssignmentCascade implements DerivedCascade {
  readonly artifact = 'project_assignments_released';

  constructor(private readonly store: ProjectStore) {}

  async cascadeForMemories(): Promise<number> {
    return 0;
  }

  async cascadeForSource(tx: Tx, sourceType: string, sourceId: string): Promise<number> {
    return this.store.releaseRefInTx(tx, sourceType, sourceId);
  }
}

/** Own module, the cascade-family precedent: table access only. */
@Module({
  providers: [ProjectStore, ProjectAssignmentCascade],
  exports: [ProjectAssignmentCascade],
})
export class ProjectAssignmentCascadeModule {}
