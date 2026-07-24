import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { ContextSuggestionDto, Principal, SuggestibleContextField } from '@cogeto/shared';
import { normalizeValue, UserContextService } from '../infrastructure/index';
import { loadPrompt, ModelGateway } from '../model-gateway/index';
import type { PromptArtifact } from '../model-gateway/index';
import { MemoryStore } from '../memory/index';
import type { MemoryRow } from '../memory/index';

/**
 * Derived context suggestions (P6.6 Issue C, decision 0053). Cogeto often
 * already knows the user's company or role from their own memories; this
 * service proposes those values for the Settings fields — conservatively:
 *
 *  - deterministic candidate rules over the user's OWN active/user-approved
 *    memories (first-person phrasing only), then
 *  - ONE pipeline-tier confirmation call (context_suggest) that can only
 *    confirm or reject, never invent, and rejects on any doubt;
 *  - a field with conflicting candidate values produces NO suggestion;
 *  - a set field is never re-derived; a dismissed value never returns.
 *
 * Suggestions are proposals only — nothing is applied without the user's
 * explicit accept in Settings (which records provenance to the memory).
 */

export const CONTEXT_SUGGEST_PROMPT = { family: 'context_suggest', version: 'v0001' } as const;

/** How many of the user's newest memories the candidate rules scan. */
const SCAN_LIMIT = 200;
/** Excerpt cap per supporting memory in the confirmation input. */
const EXCERPT_CHARS = 300;
/** How many supporting excerpts the confirmation sees per candidate. */
const MAX_EXCERPTS = 3;

/** First-person company statements, en + hr. The value group is a proper-noun
 * phrase; trailing clause punctuation ends it. */
const COMPANY_PATTERNS = [
  /\bI (?:work (?:at|for)|joined|am (?:at|with))\s+([A-Z][\p{L}\d][\p{L}\d&.' -]{0,58}?)(?=\s+(?:as|in|on|since|where)\b|[,.;:!?\n]|$)/gu,
  /\bmy company(?:,|\s+is)\s+([A-Z][\p{L}\d][\p{L}\d&.' -]{0,58}?)(?=[,.;:!?\n]|$)/gu,
  /\b(?:radim (?:u|za)|zaposlen(?:a)? (?:sam )?(?:u|kod))\s+([A-ZČĆŽŠĐ][\p{L}\d][\p{L}\d&.' -]{0,58}?)(?=\s+(?:kao|na|od|gdje)\b|[,.;:!?\n]|$)/gu,
  /\bmoja (?:tvrtka|firma)(?:,|\s+je)\s+([A-ZČĆŽŠĐ][\p{L}\d][\p{L}\d&.' -]{0,58}?)(?=[,.;:!?\n]|$)/gu,
];

/** First-person role statements, en + hr. */
const ROLE_PATTERNS = [
  /\bI(?:'m| am)(?: the| a| an)?\s+((?:senior |lead |chief )?(?:CEO|CTO|CFO|COO|founder|co-founder|owner|director|consultant|manager|engineer|developer|designer|architect|analyst|head of [\p{L} ]{2,30}))(?=\s+(?:at|of|for)\b|[,.;:!?\n]|$)/giu,
  /\bmy (?:role|title|position)(?:,|\s+is)\s+([\p{L}][\p{L}\d&.' -]{1,58}?)(?=[,.;:!?\n]|$)/giu,
  /\b(?:radim kao|ja sam|zaposlen(?:a)? (?:sam )?kao)\s+((?:viši |glavni )?(?:direktor(?:ica)?|voditelj(?:ica)?(?: [\p{L} ]{2,30})?|konzultant(?:ica)?|inženjer(?:ka)?|programer(?:ka)?|dizajner(?:ica)?|vlasni(?:k|ca)|osnivač(?:ica)?|CEO|CTO|CFO|COO))(?=\s+(?:u|za|kod)\b|[,.;:!?\n]|$)/giu,
];

/** Statements that read as PAST or hypothetical — a hit vetoes the memory. */
const NOT_CURRENT_RE =
  /\b(?:used to work|no longer|left|quit|resigned|former|until recently|if I join|might join|prije sam radi|bivš|više ne radim|ako se zaposlim|napustio|napustila)\b/iu;

interface Candidate {
  field: SuggestibleContextField;
  value: string;
  supporting: MemoryRow[];
}

const confirmSchema = z.object({
  company: z.object({ confirmed: z.boolean() }).nullable(),
  role_title: z.object({ confirmed: z.boolean() }).nullable(),
});

@Injectable()
export class ContextSuggestionsService {
  private prompt?: PromptArtifact;
  private readonly logger = new Logger(ContextSuggestionsService.name);

  constructor(
    private readonly memories: MemoryStore,
    private readonly userContext: UserContextService,
    private readonly gateway: ModelGateway,
  ) {}

  async suggestions(principal: Principal): Promise<ContextSuggestionDto[]> {
    const context = await this.userContext.get(principal.userId);
    const openFields: SuggestibleContextField[] = [];
    if (!context.company) openFields.push('company');
    if (!context.roleTitle) openFields.push('roleTitle');
    if (openFields.length === 0) return [];

    const rows = await this.memories.listForPrincipal(principal, {
      mine: true,
      limit: SCAN_LIMIT,
    });
    const evidence = rows.filter(
      (row) =>
        row.ownerId === principal.userId &&
        (row.status === 'active' || row.status === 'user_approved') &&
        row.content &&
        !NOT_CURRENT_RE.test(row.content),
    );

    const candidates: Candidate[] = [];
    for (const field of openFields) {
      const candidate = deriveCandidate(field, evidence);
      if (!candidate) continue;
      const dismissed = await this.userContext.dismissedValues(principal.userId, field);
      if (dismissed.includes(normalizeValue(candidate.value))) continue;
      candidates.push(candidate);
    }
    if (candidates.length === 0) return [];

    const confirmed = await this.confirm(candidates);
    return candidates
      .filter((candidate) => confirmed.has(candidate.field))
      .map((candidate) => {
        const source = candidate.supporting[0]!;
        return {
          field: candidate.field,
          value: candidate.value,
          sourceMemoryId: source.id,
          sourceDate: source.createdAt.toISOString(),
          sourceLabel:
            source.sourceType === 'user_note' ? 'note' : source.sourceType.replace('_', ' '),
        };
      });
  }

  /** The single confirmation call. Any failure confirms nothing. */
  private async confirm(candidates: Candidate[]): Promise<Set<SuggestibleContextField>> {
    const blocks = candidates.map((candidate) => {
      const heading =
        candidate.field === 'company'
          ? `CANDIDATE COMPANY: ${candidate.value}`
          : `CANDIDATE ROLE: ${candidate.value}`;
      const excerpts = candidate.supporting
        .slice(0, MAX_EXCERPTS)
        .map(
          (row) =>
            `- (${row.createdAt.toISOString().slice(0, 10)}) ${row.content!.slice(0, EXCERPT_CHARS)}`,
        );
      return [heading, 'evidence:', ...excerpts].join('\n');
    });
    try {
      this.prompt ??= await loadPrompt(
        CONTEXT_SUGGEST_PROMPT.family,
        CONTEXT_SUGGEST_PROMPT.version,
      );
      const verdict = await this.gateway.extractStructured(confirmSchema, {
        system: this.prompt.content,
        input: blocks.join('\n\n'),
        tier: 'pipeline',
      });
      const confirmed = new Set<SuggestibleContextField>();
      if (verdict.company?.confirmed) confirmed.add('company');
      if (verdict.role_title?.confirmed) confirmed.add('roleTitle');
      return confirmed;
    } catch (error) {
      // Conservative: no confirmation, no suggestion — never an error surface.
      this.logger.warn(
        `context_suggest_failed: ${error instanceof Error ? error.message : 'error'}`,
      );
      return new Set();
    }
  }
}

/**
 * The deterministic candidate rules: every pattern hit across the evidence,
 * grouped by normalized value. Exactly ONE distinct value may survive —
 * conflicting evidence (two companies, two roles) produces no candidate.
 */
export function deriveCandidate(
  field: SuggestibleContextField,
  evidence: MemoryRow[],
): Candidate | null {
  const patterns = field === 'company' ? COMPANY_PATTERNS : ROLE_PATTERNS;
  const byValue = new Map<string, { value: string; supporting: MemoryRow[] }>();
  for (const row of evidence) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of row.content!.matchAll(pattern)) {
        const value = match[1]?.trim().replace(/[ .]+$/u, '');
        if (!value || value.length < 2) continue;
        const key = normalizeValue(value);
        const entry = byValue.get(key) ?? { value, supporting: [] };
        if (!entry.supporting.some((m) => m.id === row.id)) entry.supporting.push(row);
        byValue.set(key, entry);
      }
    }
  }
  if (byValue.size !== 1) return null; // none, or conflicting values
  const [entry] = byValue.values();
  entry!.supporting.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return { field, value: entry!.value, supporting: entry!.supporting };
}
