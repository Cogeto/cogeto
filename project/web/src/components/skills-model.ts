import type { SkillRunDetailDto, SkillRunDto, SkillRunStepDto } from '@cogeto/shared';
import { i18next } from '../i18n';

/**
 * Pure display rules for the skill run view —
 * kept out of the component so the phrasing is unit-tested.
 */

/** The one-line, human-phrased state of a run — the list row and view header. */
export function runStatusLine(run: SkillRunDto, steps: SkillRunStepDto[] = []): string {
  const t = i18next.getFixedT(null, 'skills');
  switch (run.status) {
    case 'planning':
      return t('statusLine.planning');
    case 'awaiting_approval':
      return t('statusLine.awaitingApproval');
    case 'awaiting_input':
      return t('statusLine.awaitingInput');
    case 'running': {
      const current = steps.find((s) => s.status === 'running' || s.status === 'failed');
      if (current?.status === 'failed') {
        return t('statusLine.retrying', { step: lower(current.title) });
      }
      return current ? current.outputsSummary || current.title : t('statusLine.working');
    }
    case 'completed':
      return t('statusLine.completed');
    case 'failed':
      return run.failureReason
        ? t('statusLine.failedWithReason', { reason: run.failureReason })
        : t('statusLine.failed');
    case 'cancelled':
      return t('statusLine.cancelled');
  }
}

/** True while the view should poll for progress. */
export function runIsLive(status: SkillRunDto['status']): boolean {
  return status === 'planning' || status === 'running';
}

/** The gate is open exactly here. */
export function gateOpen(run: SkillRunDto): boolean {
  return run.status === 'awaiting_approval';
}

/**
 * The exportable text form of a finished brief: the marker text plus a
 * numbered Sources block resolving every citation — durable outside the app.
 */
export function briefExportText(detail: SkillRunDetailDto): string {
  if (!detail.brief) return '';
  const lines = [`# ${detail.skillName}: ${detail.subject}`, '', detail.brief.trim(), ''];
  const web = detail.briefCitations.filter((c) => c.kind === 'web');
  const memories = detail.briefCitations.filter((c) => c.kind === 'memory');
  if (web.length > 0 || memories.length > 0) {
    lines.push(i18next.t('skills:export.sources'));
    for (const c of web) {
      if (c.kind === 'web') {
        lines.push(
          i18next.t('skills:export.webSource', {
            marker: c.marker,
            title: c.title ?? c.url,
            url: c.url,
            date: c.fetchedAt.slice(0, 10),
          }),
        );
      }
    }
    for (const c of memories) {
      if (c.kind === 'memory') {
        lines.push(i18next.t('skills:export.memorySource', { marker: c.marker, id: c.memoryId }));
      }
    }
  }
  return lines.join('\n');
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
