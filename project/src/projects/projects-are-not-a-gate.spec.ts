import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGateFilter, memoryPointFor } from '../memory/index';

/**
 * The structural guard behind the ONE rule of V2.5 item 8.3
 * (docs/features/projects.md): **projects are organisation and filtering,
 * never authorisation.**
 *
 * These are the assertions a future change would have to delete on purpose in
 * order to turn a project into a permission, which is exactly the point: the
 * tempting change (move the association onto the memory row so the lens query
 * becomes one equality) fails here before it reaches review.
 *
 * Pure file reads plus two pure functions; no container needed.
 */

const SRC = join(__dirname, '..');

describe('projects are not a gate', () => {
  it('no_project_column_on_memory: the memory table declares no project field', () => {
    const tables = readFileSync(join(SRC, 'memory/persistence/tables.ts'), 'utf8');
    // The whole memory table declaration, including every column name.
    expect(tables.toLowerCase()).not.toContain('project');
  });

  it('no_project_in_the_migration_that_creates_memory_columns: 0056 adds none', () => {
    const migration = readFileSync(join(SRC, 'migrations/0056_projects.sql'), 'utf8');
    // The projects migration may create its OWN tables and touch chat_message's
    // lens column; it may never ALTER the memory table.
    expect(/alter\s+table\s+memory\b/i.test(migration)).toBe(false);
  });

  it('no_project_in_the_vector_payload: the Qdrant point carries the gate and provenance fields only', () => {
    const point = memoryPointFor(
      {
        id: '00000000-0000-4000-8000-000000000001',
        ownerId: 'user-1',
        scope: 'private',
        status: 'active',
        sensitive: false,
        spaceId: '00000000-0000-4000-8000-000000000001',
        sourceType: 'file',
        sourceId: 'org/user-1/private/file-1',
        validUntil: null,
      },
      [0.1, 0.2],
    );
    // space_id is a GATE field (docs/features/spaces.md): the space is the
    // gate, the project stays the lens. No project key, ever.
    expect(Object.keys(point.payload).sort()).toEqual([
      'owner_id',
      'scope',
      'sensitive',
      'source_id',
      'source_type',
      'space_id',
      'status',
      'valid_until',
    ]);
    expect(Object.keys(point.payload).join(' ')).not.toContain('project');
  });

  it('gate_filter_unchanged: the vector gate is exactly the scope/sensitive/space conditions', () => {
    const filter = buildGateFilter({ userId: 'user-1', orgId: 'org-1', roles: [] });
    // Three must-conditions: scope, sensitivity, and the space dimension
    // (docs/features/spaces.md), and nothing else. The project lens is pushed
    // on TOP of this by the store, never into it.
    expect(filter.must).toHaveLength(3);
    expect(JSON.stringify(filter)).not.toContain('project');
  });

  it('lens_is_applied_beside_the_gate: the store ANDs it, never substitutes it', () => {
    const store = readFileSync(join(SRC, 'memory/memory.store.ts'), 'utf8');
    // The lens clause exists…
    expect(store).toContain('sourceRefClause');
    // …and it is built from the value the caller passed, with no table join
    // and no import of a projects table anywhere in the memory module.
    expect(store).not.toContain('projectAssignment');
    expect(store).not.toContain("from '../projects");
  });

  it('retrieval_never_resolves_a_project: it receives refs as a value', () => {
    const retrieval = readFileSync(join(SRC, 'retrieval/retrieval.service.ts'), 'utf8');
    expect(retrieval).toContain('lens?: readonly { sourceType: string; sourceId: string }[]');
    expect(retrieval).not.toContain("from '../projects");
  });
});
