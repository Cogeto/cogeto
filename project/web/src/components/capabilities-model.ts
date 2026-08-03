import type { CapabilitySummary, ScheduledJobSummary } from '@cogeto/shared';
import { i18next } from '../i18n';
import type { Tone } from './status';

/**
 * The Capabilities panel's pure model: registry entries
 * from /api/health mapped to the words the panel shows. Kept out of the
 * component so `panel_renders_states` can pin every state's copy without a
 * DOM. Rules: state is never conveyed by colour alone (label + icon always),
 * loud states say the CONSEQUENCE in user terms, and disabled capabilities
 * say how to enable via the operator flow (the web app never toggles them
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

/**
 * Registry IDs are the server's vocabulary and are never translated; only the
 * name, description and consequence copy are, under
 * `capabilities:capability.<id>.*`. An id with no entry here keeps rendering
 * the raw id and the generic consequence, exactly as before.
 */
const KNOWN_CAPABILITIES = [
  'redaction',
  'research',
  'mail',
  'demo',
  'consoles',
  'local-models',
  'vision',
] as const;

const KNOWN_JOBS = ['dreaming', 'sweep'] as const;

function capabilityMeta(id: string): { name: string; description: string; consequence: string } {
  if (!(KNOWN_CAPABILITIES as readonly string[]).includes(id)) {
    return { name: id, description: '', consequence: i18next.t('capabilities:genericConsequence') };
  }
  return {
    name: i18next.t(`capabilities:capability.${id}.name`),
    description: i18next.t(`capabilities:capability.${id}.description`),
    consequence: i18next.t(`capabilities:capability.${id}.consequence`),
  };
}

function jobMeta(id: string): { name: string; description: string } {
  if (!(KNOWN_JOBS as readonly string[]).includes(id)) return { name: id, description: '' };
  return {
    name: i18next.t(`capabilities:job.${id}.name`),
    description: i18next.t(`capabilities:job.${id}.description`),
  };
}

export function capabilityView(summary: CapabilitySummary): CapabilityView {
  const meta = capabilityMeta(summary.id);
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
      stateLabel: i18next.t('capabilities:state.unreachable'),
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
      stateLabel: i18next.t('capabilities:state.off'),
      icon: '○',
      tone: 'neutral',
      consequence: null,
      enableHint: i18next.t('capabilities:enableHint', { id: summary.id }),
    };
  }
  return {
    ...base,
    stateLabel: i18next.t('capabilities:state.on'),
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
  const meta = jobMeta(summary.id);
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
      stateLabel: i18next.t('capabilities:jobState.overdue'),
      icon: '⚠',
      tone: 'danger',
      consequence: i18next.t(
        summary.lastRunAt
          ? 'capabilities:overdueConsequence.notCompleting'
          : 'capabilities:overdueConsequence.neverCompleted',
        { hours: summary.overdueAfterHours },
      ),
    };
  }
  if (summary.state === 'failing') {
    return {
      ...base,
      stateLabel: i18next.t('capabilities:jobState.failing'),
      icon: '✗',
      tone: 'danger',
      consequence: summary.error ?? i18next.t('capabilities:failingConsequence'),
    };
  }
  return {
    ...base,
    stateLabel: i18next.t('capabilities:jobState.ok'),
    icon: '●',
    tone: 'positive',
    consequence: null,
  };
}
