import type { CapabilitySummary, ScheduledJobSummary } from '@cogeto/shared';
import type { Tone } from './status';

/**
 * The Capabilities panel's pure model (P6.7, decision 0055): registry entries
 * from /api/health mapped to the words the panel shows. Kept out of the
 * component so `panel_renders_states` can pin every state's copy without a
 * DOM. Rules: state is never conveyed by colour alone (label + icon always),
 * loud states say the CONSEQUENCE in user terms, and disabled capabilities
 * say how to enable via the operator flow (the web app never toggles them:
 * no docker-level privilege in the product).
 */

export interface CapabilityView {
  id: string;
  name: string;
  /** One line of plain language: what the capability does. */
  description: string;
  stateLabel: string;
  icon: string;
  tone: Tone;
  /** Loud states only: what this means for the user, stated plainly. */
  consequence: string | null;
  /** Disabled states only: the operator command that enables it. */
  enableHint: string | null;
  /** Supporting line: probe detail or passive-signal note. */
  detail: string | null;
  checkedAt: string;
}

const CAPABILITY_META: Record<string, { name: string; description: string; consequence: string }> =
  {
    redaction: {
      name: 'Redaction',
      description:
        'Pseudonymizes names and other sensitive entities on this machine before any text reaches the model provider.',
      consequence:
        'Redaction is enabled but the service is unreachable: model calls will fail rather than send unredacted content.',
    },
    research: {
      name: 'Web research',
      description:
        'Searches the public web from this instance and reads approved pages into memory. You see the query before it leaves.',
      consequence: 'Research is unavailable until the search service is reachable.',
    },
    demo: {
      name: 'Demo sandbox',
      description:
        'Seeds the fictional demo workspace and serves a shared demo session. Never for an instance holding real data.',
      consequence:
        'Demo mode is set on a production instance: the guard refuses to seed. An operator must unset one of the two flags.',
    },
    consoles: {
      name: 'Infra consoles',
      description:
        'Operator-only MinIO and Qdrant consoles, served on this machine at localhost port 8443.',
      consequence: 'The consoles are enabled but not answering.',
    },
    'local-models': {
      name: 'Local models',
      description:
        'Runs model work on a local Ollama runtime instead of a hosted provider, so content stays on your hardware.',
      consequence:
        'The local model runtime is unreachable: model features on local tiers fail until it is back.',
    },
  };

const JOB_META: Record<string, { name: string; description: string }> = {
  dreaming: {
    name: 'Nightly dreaming',
    description:
      'Consolidates the day’s memories: duplicates merge, contradictions surface, stale facts age out.',
  },
  sweep: {
    name: 'Receipt sweep',
    description:
      'Verifies every deletion receipt against the stores each night, so forgetting stays provable.',
  },
};

export function capabilityView(summary: CapabilitySummary): CapabilityView {
  const meta = CAPABILITY_META[summary.id] ?? {
    name: summary.id,
    description: '',
    consequence: 'This capability is enabled but not working.',
  };
  const base = {
    id: summary.id,
    name: meta.name,
    description: meta.description,
    checkedAt: summary.checkedAt,
    detail: summary.detail ?? null,
  };
  if (summary.state === 'unreachable') {
    return {
      ...base,
      stateLabel: 'enabled, unreachable',
      icon: '⚠',
      tone: 'danger',
      consequence: meta.consequence,
      enableHint: null,
      detail: summary.error ?? base.detail,
    };
  }
  if (summary.state === 'off') {
    return {
      ...base,
      stateLabel: 'off',
      icon: '○',
      tone: 'neutral',
      consequence: null,
      enableHint: `run: cogeto features enable ${summary.id}`,
    };
  }
  return {
    ...base,
    stateLabel: 'on',
    icon: '●',
    tone: 'positive',
    consequence: null,
    enableHint: null,
  };
}

export interface JobView {
  id: string;
  name: string;
  description: string;
  stateLabel: string;
  icon: string;
  tone: Tone;
  lastRunAt: string | null;
  lastResult: string | null;
  /** Loud states only: what the state means, stated plainly. */
  consequence: string | null;
}

export function jobView(summary: ScheduledJobSummary): JobView {
  const meta = JOB_META[summary.id] ?? { name: summary.id, description: '' };
  const base = {
    id: summary.id,
    name: meta.name,
    description: meta.description,
    lastRunAt: summary.lastRunAt,
    lastResult: summary.lastResult,
  };
  if (summary.state === 'overdue') {
    return {
      ...base,
      stateLabel: 'overdue',
      icon: '⚠',
      tone: 'danger',
      consequence: `No successful run within ${summary.overdueAfterHours} hours. ${
        summary.lastRunAt ? 'The nightly job is not completing.' : 'The job has never completed.'
      }`,
    };
  }
  if (summary.state === 'failing') {
    return {
      ...base,
      stateLabel: 'failing',
      icon: '✗',
      tone: 'danger',
      consequence: summary.error ?? 'The last run did not complete.',
    };
  }
  return { ...base, stateLabel: 'ok', icon: '●', tone: 'positive', consequence: null };
}
