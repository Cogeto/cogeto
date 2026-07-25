import type { SkillRunDetailDto, SkillRunDto, SkillRunStepDto } from '@cogeto/shared';

/**
 * Pure display rules for the skill run view (Priority 7, decision 0059) —
 * kept out of the component so the phrasing is unit-tested.
 */

/** The one-line, human-phrased state of a run — the list row and view header. */
export function runStatusLine(run: SkillRunDto, steps: SkillRunStepDto[] = []): string {
  switch (run.status) {
    case 'planning':
      return 'Planning: checking what you already know';
    case 'awaiting_approval':
      return 'Searches awaiting your approval';
    case 'awaiting_input':
      return 'Waiting for your input';
    case 'running': {
      const current = steps.find((s) => s.status === 'running' || s.status === 'failed');
      if (current?.status === 'failed') return `Retrying: ${lower(current.title)}`;
      return current ? current.outputsSummary || current.title : 'Working';
    }
    case 'completed':
      return 'Completed';
    case 'failed':
      return run.failureReason ? `Failed: ${run.failureReason}` : 'Failed';
    case 'cancelled':
      return 'Cancelled';
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
    lines.push('Sources:');
    for (const c of web) {
      if (c.kind === 'web') {
        lines.push(
          `- ${c.marker} ${c.title ?? c.url} (${c.url}, fetched ${c.fetchedAt.slice(0, 10)})`,
        );
      }
    }
    for (const c of memories) {
      if (c.kind === 'memory') lines.push(`- ${c.marker} memory ${c.memoryId}`);
    }
  }
  return lines.join('\n');
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
