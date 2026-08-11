import { describe, expect, it } from 'vitest';
import { canTransition, CONNECTOR_STATES, transition } from './lifecycle';

describe('connector_lifecycle: the eight states and their edges', () => {
  it('removal_is_terminal', () => {
    for (const to of CONNECTOR_STATES) {
      if (to === 'removed') continue;
      expect(canTransition('removed', to)).toBe(false);
    }
  });

  it('needs_reauth_exits_only_via_a_fresh_credential_or_removal', () => {
    expect(canTransition('needs_reauth', 'authorised')).toBe(true);
    expect(canTransition('needs_reauth', 'disabled')).toBe(true);
    expect(canTransition('needs_reauth', 'removed')).toBe(true);
    expect(canTransition('needs_reauth', 'healthy')).toBe(false);
    expect(canTransition('needs_reauth', 'syncing')).toBe(false);
  });

  it('every_state_can_be_removed_except_removed_itself', () => {
    for (const from of CONNECTOR_STATES) {
      if (from === 'removed') continue;
      expect(canTransition(from, 'removed')).toBe(true);
    }
  });

  it('a_configured_connector_cannot_sync', () => {
    expect(canTransition('configured', 'syncing')).toBe(false);
    expect(canTransition('configured', 'healthy')).toBe(false);
  });

  it('self_transition_is_a_no_op_not_an_error', () => {
    expect(transition('healthy', 'healthy')).toEqual({ ok: true });
  });

  it('an_illegal_edge_names_itself', () => {
    const result = transition('configured', 'healthy');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('configured');
  });
});
