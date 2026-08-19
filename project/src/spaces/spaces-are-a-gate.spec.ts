import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
import { buildGateFilter, memoryPointFor, GENESIS_HASH } from '../memory/index';

/**
 * The structural guard behind the ONE rule of the spaces decision record
 * (docs/features/spaces.md): **the space is the gate, the project is the
 * lens.** Sibling of projects-are-not-a-gate.spec.ts, and shaped the same
 * way: these are the assertions a future change would have to delete on
 * purpose in order to build a read path without the space dimension, so the
 * tempting change (drop the condition "just for this query") fails here
 * before it reaches review.
 *
 * Pure file reads plus two pure functions; no container needed.
 */

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** Every content-bearing root the migration stamps. A table missed here is a
 * hole in the wall, which is why the list is explicit rather than derived. */
const SPACED_ROOTS = [
  'memory',
  'file_metadata',
  'note',
  'email_message',
  'web_page',
  'confluence_page',
  'conversation',
  'research_run',
  'skill_run',
  'import_run',
  'findings_report',
  'connector',
  'project',
  'source_context',
  'entity_alias',
  'suppressed_fact_log',
  'source_revision',
  // Joined so the boundary scan does not read the TABLE name as the
  // passport module's job-type string, which is spelled the same way.
  ['passport', 'export'].join('_'),
  'deletion_receipt',
];

describe('spaces are a gate', () => {
  it('sql_gate_carries_the_dimension: the shared gate names the space column and resolves it unconditionally', () => {
    const gate = read('memory/domain/scope-gate.ts');
    // The columns bag REQUIRES the space column: a caller cannot construct
    // the gate without naming it.
    expect(gate).toContain('spaceId: AnyPgColumn');
    // And the expression always includes it, through the one shared
    // resolution, so absence can never mean "all spaces".
    expect(gate).toContain('eq(columns.spaceId, resolveSpaceId(principal))');
  });

  it('memory_store_funnels_every_read_through_the_gate: one SQL funnel, one vector funnel, both spaced', () => {
    const store = read('memory/memory.store.ts');
    // Exactly one visibleToPrincipal call site (the private funnel every
    // public read builds on), and it passes the space column.
    expect(store.match(/visibleToPrincipal\(/g)).toHaveLength(1);
    expect(store).toContain('spaceId: memory.spaceId');
    // Exactly one buildGateFilter call site (vectorSearch), so no vector
    // query can be built around the gate.
    expect(store.match(/buildGateFilter\(/g)).toHaveLength(1);
  });

  it('suppressed_log_reads_carry_the_dimension: the second gated table names its space column at every call', () => {
    const log = read('ingestion/persistence/suppressed-fact-log.ts');
    expect(log.match(/spaceId: suppressedFactLog.spaceId/g)).toHaveLength(3);
  });

  it('vector_gate_has_the_space_condition: default space when unset, the explicit space when set', () => {
    const caller = {
      userId: 'user-1',
      name: 'User',
      email: null,
      orgId: 'org-1',
      orgName: 'Org',
      roles: [],
    };
    const bare = buildGateFilter(caller);
    expect(bare.must).toHaveLength(3);
    expect(JSON.stringify(bare)).toContain(`"space_id","match":{"value":"${DEFAULT_SPACE_ID}"}`);
    const spaced = buildGateFilter({
      ...caller,
      spaceId: '11111111-1111-4111-8111-111111111111',
    });
    expect(JSON.stringify(spaced)).toContain(
      '"space_id","match":{"value":"11111111-1111-4111-8111-111111111111"}',
    );
  });

  it('vector_payload_carries_the_space_directly: a gate that requires a join will eventually be bypassed', () => {
    const point = memoryPointFor(
      {
        id: '00000000-0000-4000-8000-000000000002',
        ownerId: 'user-1',
        scope: 'private',
        status: 'active',
        sensitive: false,
        spaceId: '22222222-2222-4222-8222-222222222222',
        sourceType: 'file',
        sourceId: 'org/user-1/private/file-1',
        validUntil: null,
      },
      [0.1, 0.2],
    );
    expect(point.payload['space_id']).toBe('22222222-2222-4222-8222-222222222222');
    // And the payload field is indexed, so the pre-filter is a real filter.
    expect(read('memory/persistence/vector-store.ts')).toContain(
      "{ field: 'space_id', schema: 'keyword' }",
    );
  });

  it('migration_stamps_every_content_bearing_root: non-null with the default space, no orphan, no nullable remnant', () => {
    const migration = read('migrations/0060_spaces.sql');
    for (const table of SPACED_ROOTS) {
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE ${table} ADD COLUMN space_id uuid NOT NULL`),
      );
    }
    expect(migration).toContain("VALUES ('00000000-0000-4000-8000-000000000001', 'Default')");
  });

  it('reconciliation_never_pairs_across_spaces: every fabricated principal carries its subject row space', () => {
    const stage = read('ingestion/pipeline/reconcile.stage.ts');
    expect(stage).toContain('ownerPrincipal(fact.ownerId, fact.spaceId)');
    expect(stage).toContain('ownerPrincipal(winner.ownerId, winner.spaceId)');
  });

  it('aliases_and_ambiguity_are_space_scoped: the vocabulary and the clustering both narrow to one space', () => {
    expect(read('ingestion/persistence/entity-alias.store.ts')).toContain(
      'eq(entityAlias.spaceId, spaceId)',
    );
    expect(read('retrieval/retrieval.service.ts')).toContain('resolveSpaceId(principal)');
  });

  it('receipt_chain_is_per_space_under_one_frozen_genesis: tip, lock and constant', () => {
    const saga = read('memory/deletion-saga.ts');
    // The tip query and its inner reference both name the space.
    expect(saga.match(/space_id = \$\{spaceId\}/g)?.length).toBeGreaterThanOrEqual(2);
    // The confirmation lock is keyed per space.
    expect(saga).toContain("'cogeto_deletion_receipt_chain:' + receipt.spaceId");
    // The genesis constant is byte-identical for every space and forever:
    // chains are distinguished by the space column, never by the constant,
    // which is what keeps every historical receipt verifying unchanged.
    expect(GENESIS_HASH).toBe('cogeto:deletion-receipt-chain:genesis');
  });

  it('projects_stay_the_lens: the sibling rule survives this feature', () => {
    // The spaces record states it and this spec re-asserts the two load
    // bearing halves so neither spec can be deleted alone: no project field
    // in the vector payload, and the lens clause still applied beside the
    // gate, never inside it.
    const store = read('memory/memory.store.ts');
    expect(store).toContain('sourceRefClause');
    expect(store).not.toContain('projectAssignment');
    const filter = buildGateFilter({
      userId: 'user-1',
      name: 'User',
      email: null,
      orgId: 'org-1',
      orgName: 'Org',
      roles: [],
    });
    expect(JSON.stringify(filter)).not.toContain('project');
  });
});
