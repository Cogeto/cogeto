import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The structural guard of session 2 (docs/features/spaces.md): isolation in
 * depth. The sibling of spaces-are-a-gate.spec.ts, one session over: these
 * are the assertions a future change would have to delete on purpose in order
 * to compare, pair, link or aggregate across the wall, so the tempting change
 * (drop the condition "just for this query") fails here before review.
 *
 * Pure file reads; no container needed.
 */

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('spaces isolation in depth', () => {
  it('candidate_generation_is_constrained_in_the_query_and_loud_after_it: the gate rides the fact row principal and a crossing row stops the engine', () => {
    const stage = read('ingestion/pipeline/reconcile.stage.ts');
    // The constraint sits INSIDE the gated candidate reads (the fabricated
    // principal carries the fact row's space), never in a post-filter.
    expect(stage).toContain('ownerPrincipal(fact.ownerId, fact.spaceId)');
    // And the loop refuses, rather than skims, a row that crossed anyway.
    expect(stage).toContain('crossed the space wall');
  });

  it('checked_pair_ledger_is_space_aware: the row carries the pair one space, stamped from the fact at record time', () => {
    expect(read('ingestion/persistence/tables.ts')).toMatch(
      /checked_pair'[\s\S]{0,900}spaceId: uuid\('space_id'\)\.notNull\(\)/,
    );
    const store = read('ingestion/persistence/checked-pair.store.ts');
    expect(store).toContain('spaceId: entry.spaceId');
    // Every reconcile record call stamps the fact's space — three families:
    // dedup, the deterministic quantity rule, and the judged contradiction.
    expect(
      read('ingestion/pipeline/reconcile.stage.ts').match(/spaceId: fact\.spaceId/g),
    ).toHaveLength(3);
    expect(read('migrations/0061_spaces_isolation.sql')).toContain(
      'ALTER TABLE checked_pair ADD COLUMN space_id uuid NOT NULL',
    );
  });

  it('pair_actions_refuse_cross_space_pairs_at_the_aggregate: merge, contradiction, supersession and follow all funnel through the one lock', () => {
    const aggregate = read('memory/reconciliation.ts');
    expect(aggregate).toContain('live in different spaces and can never form a pair');
    // The refusal sits in lockPair, the one funnel every pair action uses.
    expect(aggregate.match(/lockPair\(/g)!.length).toBeGreaterThanOrEqual(5);
  });

  it('nightly_pass_processes_each_space_independently: one job iterating per-(owner, space) groups', () => {
    const dreaming = read('ingestion/dreaming.service.ts');
    expect(dreaming).toContain('${row.ownerId}:${row.spaceId}');
    expect(dreaming).toContain('byOwnerSpace');
  });

  it('aliases_are_per_space_in_write_read_and_uniqueness: two spaces may alias the same surface form differently', () => {
    const store = read('ingestion/persistence/entity-alias.store.ts');
    expect(store).toContain('eq(entityAlias.spaceId, spaceId)');
    // The reconcile engine loads the index per (owner, space).
    expect(read('ingestion/pipeline/reconcile.stage.ts')).toContain(
      'aliasIndexFor(fact.ownerId, fact.spaceId)',
    );
  });

  it('machine_revision_links_carry_their_space: both detected paths stamp it and the reads seal on it', () => {
    expect(read('imports/import-coordinator.ts')).toContain('spaceId: principal.spaceId');
    expect(read('connectors/sync-engine.ts')).toContain('spaceId: row.spaceId');
    const store = read('ingestion/persistence/source-revision.store.ts');
    expect(store).toContain('eq(sourceRevision.spaceId, resolveSpaceId(principal))');
  });

  it('retrieval_lens_rides_every_arm: the widen arm no longer escapes it', () => {
    const retrieval = read('retrieval/retrieval.service.ts');
    // Four gated arms carry the lens: the shared searchOpts covers three,
    // and the widen entitySearch names it explicitly.
    expect(retrieval.match(/sourceRefs: opts\.lens/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('limit_bounded_pools_filter_the_space_inside_the_query: conversation search, the change feed, and both badge ledgers', () => {
    const search = read('chat/conversation-search.ts');
    expect(search.match(/space_id = \$\{spaceId\}/g)).toHaveLength(2);
    expect(read('memory/memory.store.ts')).toContain('spaceId: resolveSpaceId(principal)');
    expect(read('ingestion/persistence/extraction-gate.store.ts')).toContain(
      'eq(extractionGateRefusal.spaceId, options.spaceId ?? DEFAULT_SPACE_ID)',
    );
    expect(read('files/persistence/file-read-report.ts')).toContain(
      'eq(fileReadReport.spaceId, options.spaceId ?? DEFAULT_SPACE_ID)',
    );
  });

  it('approvals_are_space_scoped_surfaces: stamped at creation, listed and decided in their own space only', () => {
    const service = read('agents/approval.service.ts');
    expect(service).toContain('spaceId: resolveSpaceId(principal)');
    expect(
      service.match(/eq\(approval\.spaceId, resolveSpaceId\(principal\)\)/g)!.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('checksum_dedup_is_per_space_everywhere_including_the_cleanup_cli: the same file in two spaces is never a duplicate pair', () => {
    expect(read('memory/file-store.ts')).toContain(
      'eq(fileMetadata.spaceId, spaceId ?? DEFAULT_SPACE_ID)',
    );
    const plan = read('entrypoints/dedupe-plan.ts');
    expect(plan).toContain('d.space_id = f.space_id');
  });

  it('budgets_and_caps_stay_instance_wide_while_spend_stays_attributable: the usage scope carries the space for audit, never for a cap', () => {
    const context = read('infrastructure/usage-context.ts');
    expect(context).toContain('It NEVER affects a cap');
    // The budget decorator's inputs are untouched: no space reaches a limit.
    expect(read('infrastructure/model-budget.ts')).not.toContain('spaceId');
    expect(read('infrastructure/daily-counters.ts')).not.toContain('spaceId');
    // And the egress audit entry stamps it, so spend is attributable.
    expect(read('infrastructure/model-egress-audit.ts')).toContain('currentUsageSpaceId()');
  });

  it('audit_gains_the_space_attribute_without_becoming_a_gate: nullable column, no foreign key, filter on the read side', () => {
    const migration = read('migrations/0061_spaces_isolation.sql');
    expect(migration).toContain('ALTER TABLE audit_log ADD COLUMN space_id uuid;');
    expect(migration).not.toMatch(/audit_log ADD COLUMN space_id uuid[^;]*REFERENCES/);
    const audit = read('infrastructure/audit.ts');
    expect(audit).toContain('spaceId: entry.spaceId ?? null');
    expect(audit).toContain('eq(auditLog.spaceId, filter.spaceId)');
  });

  it('space_deletion_is_the_ordinary_saga_plus_a_structural_completeness_proof: no second mechanism, receipts outlive the space', () => {
    const saga = read('memory/deletion-saga.ts');
    // The space entry is requestSourceDeletion with subject and actor split,
    // retainShared off — the same one transaction, cascades and receipt.
    expect(saga).toContain('eraseSpaceSource');
    expect(saga).toMatch(/eraseSpaceSource[\s\S]{0,400}retainShared: false/);
    const erasure = read('spaces/space-erasure.service.ts');
    // The final row delete is the schema-level completeness proof...
    expect(erasure).toContain('this.db.delete(space).where(eq(space.id, spaceId))');
    // ...and the default space is never deletable.
    expect(erasure.match(/default space cannot be deleted/g)!.length).toBeGreaterThanOrEqual(2);
    // Receipts outlive the space: the FK is gone, the column (the chain key)
    // stays, and the sweep walks chains from receipts, never the space table.
    const migration = read('migrations/0061_spaces_isolation.sql');
    expect(migration).toContain(
      'ALTER TABLE deletion_receipt DROP CONSTRAINT deletion_receipt_space_id_fkey',
    );
    expect(read('memory/integrity-sweep.ts')).not.toContain('from(space)');
  });

  it('passport_and_report_expiry_narrow_to_the_deletion_space: a deletion in one space cannot invalidate another space artifact', () => {
    expect(read('passport/passport.source-expiry.ts')).toContain(
      'eq(passportExport.spaceId, spaceId)',
    );
    expect(read('reports/report.source-expiry.ts')).toContain(
      'eq(findingsReport.spaceId, spaceId)',
    );
    expect(read('memory/deletion-saga.ts')).toContain(
      'cascade.expireForOwner(tx, principal.userId, spaceId)',
    );
  });

  it('connectors_belong_to_exactly_one_space_from_every_entry_point: the confluence connect stamps the caller space', () => {
    expect(read('confluence/confluence.controller.ts')).toContain(
      'spaceId: resolveSpaceId(request.principal)',
    );
  });
});
