import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The structural half of the settings split (docs/features/spaces.md
 * section 4, migration 0062), shaped like its siblings: these are the
 * assertions a future change would have to delete on purpose in order to
 * read or write a space-scoped setting without its space, so the tempting
 * change (drop the condition "just for this call") fails here before it
 * reaches review.
 */

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('the settings split is structural', () => {
  it('capture_defaults_key_on_user_and_space: the table, the reads and the upsert all carry the dimension', () => {
    const tables = read('settings/persistence/tables.ts');
    expect(tables).toContain('primaryKey({ columns: [t.userId, t.spaceId] })');
    const service = read('settings/user-settings.service.ts');
    // Both principal reads resolve the caller's space unconditionally.
    expect(service.match(/eq\(userSettings\.spaceId, resolveSpaceId\(principal\)\)/g)).toHaveLength(
      1,
    );
    expect(service).toContain('target: [userSettings.userId, userSettings.spaceId]');
    // The by-id lookup REQUIRES a space, so no worker path can silently read
    // across the wall.
    expect(service).toContain('async defaultScopeFor(userId: string, spaceId: string)');
  });

  it('default_scope_callers_name_their_space: the conversation row and the intake default', () => {
    expect(read('chat/chat.source-reader.ts')).toContain(
      'defaultScopeFor(row.ownerId, rows[0]!.spaceId)',
    );
    expect(read('email/email-intake.service.ts')).toContain(
      'defaultScopeFor(recipient.userId, DEFAULT_SPACE_ID)',
    );
  });

  it('the_gate_is_sealed_with_its_space: every gate query and every stamp carries the dimension', () => {
    const store = read('ingestion/persistence/extraction-gate.store.ts');
    // decisionFor filters both tables on the SOURCE row's space.
    expect(store.match(/eq\(extractionGate\.spaceId, spaceId\)/g)?.length).toBeGreaterThanOrEqual(
      2,
    );
    expect(
      store.match(/eq\(extractionGateRule\.spaceId, spaceId\)/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    // The pipeline chokepoint passes the source's own space.
    expect(read('ingestion/pipeline/pipeline.service.ts')).toContain('spaceId: source.spaceId,');
  });

  it('the_migration_stamps_and_backfills: settings and gate tables gain non-null space columns', () => {
    const migration = read('migrations/0062_spaces_settings_split.sql');
    for (const table of ['user_settings', 'extraction_gate', 'extraction_gate_rule']) {
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE ${table} ADD COLUMN space_id uuid NOT NULL`),
      );
    }
    expect(migration).toContain('ADD PRIMARY KEY (user_id, space_id)');
    // The gate uniqueness keys gained the dimension under their old names.
    expect(migration).toContain('ON extraction_gate (owner_id, space_id, source_type)');
    expect(migration).toContain(
      'ON extraction_gate_rule (owner_id, space_id, source_type, dimension, value)',
    );
    // The settings row CASCADES with its space (per-user preference state,
    // never content); the gate rows stay NO ACTION and go through the
    // ingestion cleanup leg, keeping the deletion completeness proof.
    expect(migration).toContain('REFERENCES space (id) ON DELETE CASCADE');
  });

  it('space_deletion_takes_the_gate_configuration: the cleanup leg is registered in both roots', () => {
    for (const root of ['entrypoints/app-root.module.ts', 'entrypoints/worker-root.module.ts']) {
      const wired = read(root);
      expect(wired).toContain('ExtractionGateSpaceCleanupModule');
      expect(wired).toContain('ExtractionGateSpaceCleanup,');
    }
  });
});
