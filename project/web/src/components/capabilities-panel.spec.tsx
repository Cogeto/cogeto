// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { CapabilitySummary, ScheduledJobSummary } from '@cogeto/shared';
import { capabilityView, jobView } from './capabilities-model';
import { CapabilitiesSection } from './CapabilitiesPanel';

/**
 * The Capabilities panel (P6.7, decision 0055):
 *
 *   panel_renders_states — every capability/job state renders with its correct
 *     plain-language messaging from fixtures (consequence on loud states,
 *     enable hint on disabled ones, last-check time always).
 *   panel_a11y — axe passes on the rendered panel across all states, and no
 *     state is conveyed by colour alone (label + icon are always present).
 */

const CHECKED_AT = new Date(Date.now() - 12_000).toISOString();

const cap = (over: Partial<CapabilitySummary> & Pick<CapabilitySummary, 'id'>): CapabilitySummary =>
  ({ state: 'on', probed: true, checkedAt: CHECKED_AT, ...over }) as CapabilitySummary;

const job = (
  over: Partial<ScheduledJobSummary> & Pick<ScheduledJobSummary, 'id'>,
): ScheduledJobSummary =>
  ({
    state: 'ok',
    lastRunAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    lastResult: '2 merged, 1 contradictions',
    overdueAfterHours: 26,
    checkedAt: CHECKED_AT,
    ...over,
  }) as ScheduledJobSummary;

/** One fixture per state across the whole registry. */
const FIXTURE: { capabilities: CapabilitySummary[]; jobs: ScheduledJobSummary[] } = {
  capabilities: [
    cap({ id: 'redaction', state: 'unreachable', error: 'sidecar unreachable' }),
    cap({ id: 'research', state: 'off', probed: false }),
    cap({ id: 'demo', state: 'off', probed: false }),
    cap({ id: 'consoles', state: 'on', probed: false, detail: 'localhost-only edge' }),
    cap({ id: 'local-models', state: 'on', detail: 'runtime reachable' }),
  ],
  jobs: [
    job({ id: 'dreaming', state: 'overdue', error: 'no successful run since yesterday' }),
    job({ id: 'sweep' }),
  ],
};

const html = renderToStaticMarkup(
  <CapabilitiesSection capabilities={FIXTURE.capabilities} jobs={FIXTURE.jobs} />,
);

describe('panel_renders_states', () => {
  it('a loud fail-closed capability states the consequence in user terms', () => {
    expect(html).toContain('Redaction');
    expect(html).toContain('enabled, unreachable');
    expect(html).toContain('model calls will fail rather than send unredacted content');
  });

  it('a disabled capability says how to enable it via the operator flow, not a UI toggle', () => {
    expect(html).toContain('cogeto features enable research');
    expect(html).toContain('cogeto features enable demo');
    expect(html).not.toContain('<button'); // observing surface: no toggles
  });

  it('healthy capabilities show on with their description and last-check time', () => {
    expect(html).toContain('Local models');
    expect(html).toContain('local Ollama runtime');
    expect(html).toContain('checked ');
  });

  it('jobs show last-run relative time, result, and a prominent overdue message', () => {
    expect(html).toContain('Nightly dreaming');
    expect(html).toContain('last ran 6 h ago');
    expect(html).toContain('No successful run within 26 hours');
    expect(html).toContain('Last run: 2 merged, 1 contradictions');
    expect(html).toContain('Receipt sweep');
  });

  it('the degrade-with-message consequence names the research outage plainly', () => {
    const research = capabilityView(cap({ id: 'research', state: 'unreachable', error: 'down' }));
    expect(research.consequence).toBe(
      'Research is unavailable until the search service is reachable.',
    );
  });

  it('no product copy in the panel carries typographic dashes', () => {
    expect(html).not.toMatch(/[–—]/);
  });
});

describe('panel_a11y', () => {
  it('axe passes on the rendered panel across all states', async () => {
    const host = document.createElement('main');
    host.innerHTML = html;
    document.body.appendChild(host);
    try {
      const results = await axe.run(host);
      const summary = results.violations
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)
        .join('\n');
      expect(results.violations, summary).toEqual([]);
    } finally {
      host.remove();
    }
  });

  it('no state is conveyed by colour alone: every state has a distinct label and icon', () => {
    const states = [
      capabilityView(cap({ id: 'redaction', state: 'on' })),
      capabilityView(cap({ id: 'redaction', state: 'unreachable', error: 'x' })),
      capabilityView(cap({ id: 'redaction', state: 'off', probed: false })),
    ];
    expect(new Set(states.map((s) => s.stateLabel)).size).toBe(3);
    expect(new Set(states.map((s) => s.icon)).size).toBe(3);

    const jobStates = [
      jobView(job({ id: 'dreaming' })),
      jobView(job({ id: 'dreaming', state: 'overdue' })),
      jobView(job({ id: 'dreaming', state: 'failing', error: 'died' })),
    ];
    expect(new Set(jobStates.map((s) => s.stateLabel)).size).toBe(3);
    expect(new Set(jobStates.map((s) => s.icon)).size).toBe(3);
  });
});
