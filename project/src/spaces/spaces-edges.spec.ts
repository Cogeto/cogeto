import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The structural guard of session 4 (docs/features/spaces.md section 6c):
 * the edges. Content enters the instance without a person standing in a
 * space through exactly three doors (inbound mail, the bearer API used by a
 * machine, connector syncs), and each door's space is EXPLICIT and recorded:
 * a routing rule, a per-credential binding, or the connector row. These are
 * the assertions a future change would have to delete on purpose in order to
 * reintroduce a silent default, so the tempting change ("fall back to the
 * default space just here") fails before review.
 *
 * Pure file reads; no container needed.
 */

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('spaces edges (session 4)', () => {
  // ── Email intake routing ────────────────────────────────────────────────────

  it('intake_routes_before_it_stores: the message row and its attachment sources stamp the resolved space in one transaction', () => {
    const intake = read('email/email-intake.service.ts');
    // The routed space is resolved BEFORE store() and stamped explicitly on
    // the message row: the schema DEFAULT is no longer how mail gets a space.
    expect(intake).toContain('aliasRouteFor(recipient.userId, alias)');
    expect(intake).toMatch(/values\(\{\s*id: emailId,[\s\S]{0,700}spaceId,/);
    // The attachment file source lands in the SAME routed space.
    expect(intake).toMatch(/this\.files\.record\(tx, \{[\s\S]{0,400}spaceId,/);
    // An alias the recipient has not defined REFUSES that recipient, recorded
    // and owner-attributed, never a fallback.
    expect(intake).toContain("'alias_not_recognized', recipient.userId");
  });

  it('sender_rules_carry_a_space_target_and_the_specific_rule_wins: address over domain, per owner', () => {
    const service = read('email/email-allowlist.service.ts');
    expect(service).toContain('routesMatching');
    expect(service).toContain(
      'entries.filter((entry) => senderMatchesAllowlist(matchedSender, [entry]))',
    );
    expect(service).toContain("matched.find((entry) => entry.kind === 'address') ?? matched[0]!");
    // Both rule tables name their target space, NOT NULL, backfilled to the
    // default space so pre-routing behaviour is byte-identical.
    const migration = read('migrations/0063_spaces_edges.sql');
    expect(migration).toContain('ALTER TABLE email_allowlist ADD COLUMN space_id uuid NOT NULL');
    expect(migration).toMatch(
      /CREATE TABLE email_alias[\s\S]{0,300}space_id\s+uuid NOT NULL REFERENCES space \(id\)/,
    );
  });

  it('routing_rules_die_with_their_target_space: the email cleanup leg removes both rule kinds, never re-points', () => {
    const cleanup = read('email/email-space-cleanup.ts');
    expect(cleanup).toContain("artifact = 'email_routing_rules'");
    expect(cleanup).toContain('.delete(emailAllowlist)');
    expect(cleanup).toContain('.delete(emailAlias)');
    // Bound in both roots' cleanup arrays.
    expect(read('entrypoints/app-root.module.ts')).toContain('EmailRoutingSpaceCleanup,');
    expect(read('entrypoints/worker-root.module.ts')).toContain('EmailRoutingSpaceCleanup,');
  });

  // ── Machine callers carry a space ───────────────────────────────────────────

  it('machine_callers_have_no_ambient_default: unbound is refused, a disagreeing header is refused, the binding is the space', () => {
    const guard = read('identity/bearer-auth.guard.ts');
    // A machine is a token without a human profile (no email claim),
    // classified at the guard where the refusal lives: Principal itself
    // stays exactly the identity seam's claims. The ONE exemption is the
    // demo sandbox's published principal (a machine user by construction),
    // demo mode only.
    expect(guard).toContain(
      'if (principal.email === null && principal.userId !== this.demoPrincipalId())',
    );
    expect(guard).toContain('if (!this.webConfig?.demoMode) return null;');
    // Unbound (or no adapter wired at all) refuses: fail closed.
    expect(guard).toContain(
      'machine callers must be bound to a space: ask an administrator to bind this',
    );
    // A header may only restate the binding; it can never reach another space.
    expect(guard).toContain('bound to a different space');
    expect(guard).toContain('spaceId = bound;');
    // Humans keep the absent-header resolution to the default space (6a):
    // the guard still spreads the header value for non-machine principals.
    expect(guard).toContain('let spaceId = headerSpace;');
  });

  it('the_guard_optional_deps_are_exported: every module-context guard instance carries the binding lookup and the demo exemption', () => {
    // @UseGuards(BearerAuthGuard) on another module's controller builds the
    // guard in THAT module's context; an @Optional dependency provided in
    // IdentityModule but not exported silently resolves to undefined there,
    // which would confine the machine rule to identity's own routes. Found
    // live by the demo seed refusing its own POST /api/notes.
    const module = read('identity/identity.module.ts');
    expect(module).toContain('...(machineBindings?.adapter ? [MACHINE_SPACE_BINDINGS] : [])');
    expect(module).toContain('...(options.webConfig ? [WEB_CONFIG_OPTIONS] : [])');
  });

  it('the_binding_is_credential_state_about_a_space: spaces owns the rows, identity owns the port, CASCADE unbinds', () => {
    expect(read('identity/machine-space-bindings.port.ts')).toContain('MACHINE_SPACE_BINDINGS');
    expect(read('spaces/machine-binding.service.ts')).toContain('implements MachineSpaceBindings');
    expect(read('migrations/0063_spaces_edges.sql')).toMatch(
      /CREATE TABLE machine_space_binding[\s\S]{0,300}ON DELETE CASCADE/,
    );
    // Bound in BOTH roots through the identity seam's registration options.
    expect(read('entrypoints/app-root.module.ts')).toContain(
      'machineBindings: { imports: [MachineBindingModule], adapter: MachineBindingService }',
    );
    expect(read('entrypoints/worker-root.module.ts')).toContain(
      'machineBindings: { imports: [MachineBindingModule], adapter: MachineBindingService }',
    );
  });

  // ── Connectors belong to a space ────────────────────────────────────────────

  it('connectors_stamp_the_creator_space_at_both_entry_points: create requires the space, no silent default remains', () => {
    expect(read('confluence/confluence.controller.ts')).toContain(
      'spaceId: resolveSpaceId(request.principal)',
    );
    expect(read('connectors/connectors.controller.ts')).toContain(
      'spaceId: resolveSpaceId(request.principal)',
    );
    const store = read('connectors/persistence/connector-store.ts');
    // The optional-space seams became REQUIRED parameters (section 6c): a
    // caller cannot forget the space and silently get the default partition.
    expect(store).toContain('spaceId: string;');
    expect(store).not.toContain('spaceId ?? DEFAULT_SPACE_ID');
    expect(store).toContain('async byIdForOwner(id: string, ownerId: string, spaceId: string)');
    expect(store).toContain('async listForOwner(ownerId: string, spaceId: string)');
  });

  it('a_connector_space_is_immutable: no store method ever writes the column after creation', () => {
    const store = read('connectors/persistence/connector-store.ts');
    // Every `.set({...})` in the connector store leaves space_id alone; the
    // one write is the INSERT in create().
    const sets = store.match(/\.set\(\{[\s\S]*?\}\)/g) ?? [];
    expect(sets.length).toBeGreaterThan(0);
    for (const block of sets) expect(block).not.toContain('spaceId');
    // And no update statement in the module touches the column: the 300
    // characters after every `.update(connector)` never name it.
    for (const match of store.matchAll(/\.update\(connector\)/g)) {
      expect(store.slice(match.index, match.index + 300)).not.toContain('spaceId');
    }
  });

  it('the_ledger_upstream_state_read_is_sealed_by_the_connector_join: a foreign ref cannot surface another space', () => {
    const ledger = read('connectors/persistence/item-ledger.ts');
    expect(ledger).toMatch(/upstreamStateForSources\(\s*ownerId: string,\s*spaceId: string,/);
    expect(ledger).toContain('innerJoin(connector, eq(connector.id, connectorItem.connectorId))');
    expect(ledger).toContain('eq(connector.spaceId, spaceId)');
    expect(read('sources/source-catalog.service.ts')).toContain(
      'upstreamStateForSources(ownerId, spaceId, fileKeys)',
    );
  });

  // ── Space-scoped artifacts ──────────────────────────────────────────────────

  it('the_report_scope_block_states_its_space: schema 1.2, the assembler resolves and sanitizes the name', () => {
    const format = read('reports/report-format.ts');
    expect(format).toContain('space_id: z.string()');
    expect(format).toContain('space_name: z.string().nullable()');
    const assembler = read('reports/report-assembler.ts');
    expect(assembler).toContain('const spaceId = resolveSpaceId(principal);');
    expect(assembler).toContain('space_id: spaceId,');
    expect(assembler).toContain('space_name: spaceName,');
    // The PDF states it on the cover and in the provenance table.
    const pdf = read('reports/report-pdf.ts');
    expect(pdf).toContain("t('cover.space')");
    expect(pdf).toContain("t('provenance.space')");
  });

  it('report_ledger_reads_are_sealed: the delta baseline, the single-flight dedupe and the by-id reads carry the space', () => {
    const store = read('reports/report.store.ts');
    expect(store).toMatch(/previousReady\(\s*userId: string,\s*spaceId: string,/);
    expect(store).toMatch(
      /unfinishedForOwner\(\s*executor: Db \| Tx,\s*userId: string,\s*spaceId: string,/,
    );
    expect(store.match(/eq\(findingsReport\.spaceId, spaceId\)/g)?.length).toBeGreaterThanOrEqual(
      3,
    );
    // The executor hands the run row's own space to the baseline lookup.
    expect(read('reports/report-export.executor.ts')).toContain('run.spaceId,');
  });

  it('attention_read_state_is_per_space: the unread marker and dismissals key on (owner, space), CASCADE', () => {
    const service = read('attention/attention.service.ts');
    expect(service).toContain('target: [attentionState.ownerId, attentionState.spaceId]');
    expect(service).toContain('spaceId: resolveSpaceId(principal), itemKey: key');
    expect(service).toContain('eq(attentionState.spaceId, spaceId)');
    expect(service).toContain('eq(attentionDismissal.spaceId, spaceId)');
    const migration = read('migrations/0063_spaces_edges.sql');
    expect(migration).toContain('ALTER TABLE attention_state ADD PRIMARY KEY (owner_id, space_id)');
    expect(migration).toContain(
      'ALTER TABLE attention_dismissal ADD PRIMARY KEY (owner_id, space_id, item_key)',
    );
  });

  it('the_import_summary_revision_aggregate_carries_the_space: the last unspaced aggregate in the isolation surface', () => {
    expect(read('ingestion/persistence/source-revision.store.ts')).toMatch(
      /revisionCountsForSuccessors\(\s*db: DbOrTx,\s*spaceId: string,/,
    );
    expect(read('imports/import-coordinator.ts')).toContain(
      'revisionCountsForSuccessors(this.db, resolveSpaceId(principal), keys)',
    );
  });

  it('the_passport_read_is_already_sealed: one space of receipts, the export names it (session 1, re-pinned here)', () => {
    expect(read('memory/memory.store.ts')).toMatch(
      /confirmedReceiptsForOwner\([\s\S]{0,600}eq\(deletionReceipt\.spaceId, spaceId\)/,
    );
    expect(read('passport/passport-export.executor.ts')).toContain(
      'confirmedReceiptsForOwner(principal.userId, request.spaceId)',
    );
    // And the status/download by-id reads carry the caller's space, exactly
    // like the reports': an export in another space reads as absent.
    expect(read('passport/passport.store.ts')).toContain(
      '...(spaceId ? [eq(passportExport.spaceId, spaceId)] : [])',
    );
    expect(
      read('passport/passport.service.ts').match(
        /getForOwner\(principal\.userId, id, resolveSpaceId\(principal\)\)/g,
      )?.length,
    ).toBe(2);
  });
});
