import { Injectable, Module } from '@nestjs/common';
import type { ProjectExtractionPolicy, ProjectPolicyPort } from '../ingestion/index';
import { ProjectStore } from './persistence/project.store';

/**
 * The projects side of ingestion's per-project extraction policy port (V2.5
 * item 8.3 issue C4). Ingestion defines the port because the pipeline is the
 * enforcement point; this implements it because a project is what carries the
 * numbers, and the composition root binds the two, exactly like the ingestion
 * guard and the eligibility hook.
 *
 * A source in no project, or in a project with nothing configured, yields
 * null and the pipeline runs byte-identically to one that never heard of
 * projects.
 */
@Injectable()
export class ProjectPolicySource implements ProjectPolicyPort {
  constructor(private readonly store: ProjectStore) {}

  async policyForSource(
    sourceType: string,
    sourceId: string,
  ): Promise<ProjectExtractionPolicy | null> {
    const row = await this.store.projectByRef(sourceType, sourceId);
    if (!row) return null;
    if (
      row.extractionEnabled === null &&
      row.extractionFactBudget === null &&
      row.extractionRetentionDays === null
    ) {
      return null;
    }
    return {
      enabled: row.extractionEnabled,
      factBudget: row.extractionFactBudget,
      retentionDays: row.extractionRetentionDays,
    };
  }
}

/** Own module, the port-family precedent: table access only. */
@Module({
  providers: [ProjectStore, ProjectPolicySource],
  exports: [ProjectPolicySource],
})
export class ProjectPolicyModule {}
