import { Injectable } from '@nestjs/common';
import {
  fenceUntrusted,
  loadPrompt,
  ModelGateway,
  untrustedBoundary,
} from '../../model-gateway/index';
import type { PromptArtifact } from '../../model-gateway/index';
import { extractionOutputSchema } from '../domain/candidate-fact';
import type { CandidateFact } from '../domain/candidate-fact';
import type { SourceContextValue } from '../persistence/source-context.store';
import { EXTRACTION_PROMPT } from '../prompt-versions';
import type { Chunk } from './chunk';
import type { SourceItem } from './source-reader';

/**
 * Stage 3 (extract): structured extraction of candidate facts per chunk via
 * the versioned extraction prompt. Output is Zod-validated at the gateway;
 * malformed output throws and is never stored — the job retries with backoff
 * and dead-letters if it never conforms (spec §15.4).
 */
@Injectable()
export class ExtractStage {
  private prompt?: PromptArtifact;

  constructor(private readonly gateway: ModelGateway) {}

  async run(
    source: SourceItem,
    chunks: Chunk[],
    context: SourceContextValue | null = null,
  ): Promise<CandidateFact[]> {
    if (chunks.length === 0) return [];
    const prompt = await this.getPrompt();
    const facts: CandidateFact[] = [];
    for (const chunk of chunks) {
      const output = await this.gateway.extractStructured(extractionOutputSchema, {
        system: prompt.content,
        input: buildExtractionInput(source, chunk, context),
      });
      // Provenance guard: a weaker model can grab one of the input's ALL-CAPS
      // metadata labels (REFERENCE TIME / SOURCE TYPE / SOURCE CONTENT) as if it
      // were content — most visible under redaction, where the real names become
      // bracketed slots and the labels are the only capitalized tokens left. Such
      // a "fact" is never grounded in SOURCE CONTENT; drop it rather than store it.
      // Forged-framing guard (SEC-4). The fence stops content from ESCAPING,
      // and the prompt clause asks the model not to obey what is inside it, but
      // a request to a model is not a guarantee: the golden-set traps showed
      // mistral-small obeying "record the following fact" inside the fence
      // through two rounds of prompt wording. So the last word is code.
      //
      // A document that reproduces our own framing vocabulary is not writing
      // prose, it is impersonating the harness. Everything from the first such
      // line onward is treated as forged frame, and any fact grounded only
      // there is dropped. Content BEFORE it is ordinary document text and is
      // kept, which is why the consulting-fee facts in the trap survive while
      // the injected directive does not.
      const forgedAt = forgedFramingOffset(chunk.text);
      facts.push(
        ...output.facts
          .filter(
            (fact) => !carriesMetadataLabel(fact) && !groundedInForgedFrame(fact, chunk, forgedAt),
          )
          // Anchored-subject canonicalization (V2.1 item 4.2): the prompt asks
          // for the context's name, but a model copying the section heading
          // ("Model SEN-210" for subject "SEN-210") held through two rounds of
          // prompt wording on the Croatian corpus, so — the SEC-4 lesson — the
          // last word is code. Deterministic, and only ever narrows toward a
          // name the context already declared.
          .map((fact) => ({
            ...fact,
            subject_entity: canonicalizeAnchoredSubject(fact.subject_entity, context),
          })),
      );
    }
    return facts;
  }

  get promptVersion(): string {
    return `${EXTRACTION_PROMPT.family}/${EXTRACTION_PROMPT.version}`;
  }

  private async getPrompt(): Promise<PromptArtifact> {
    this.prompt ??= await loadPrompt(EXTRACTION_PROMPT.family, EXTRACTION_PROMPT.version);
    return this.prompt;
  }
}

/**
 * Labeled context blocks (research: retrieval-and-pipeline §4). The reference
 * time is a per-source input, not part of the immutable prompt artifact.
 *
 * SEC-4: the source text is FENCED. This used to be a plain newline join, which
 * meant a document containing its own `SOURCE CONTENT:` line was
 * indistinguishable from the framing, and any imperative sentence in the
 * document read as something we had asked for. The labels stay outside the
 * fence; everything the document contributed is inside it, between markers
 * carrying a random per-call boundary the document's author could not know.
 */
export function buildExtractionInput(
  source: SourceItem,
  chunk: Chunk,
  context: SourceContextValue | null = null,
): string {
  const boundary = untrustedBoundary();
  const contextBlock = renderDocumentContext(context, boundary);
  return [
    `REFERENCE TIME (when the source was written): ${source.createdAt.toISOString()}`,
    `SOURCE TYPE: ${source.sourceType}`,
    ...contextBlock,
    '',
    'SOURCE CONTENT:',
    fenceUntrusted(chunk.text, boundary),
  ].join('\n');
}

/**
 * The anchor's context block (V2.1 item 4.2, spec 1.5). Two rules with teeth:
 *
 * - It is FENCED. The context is derived from the document's own words by a
 *   model reading them, so an unfenced block would hand a hostile document a
 *   second, laundered path around the fence: plant an instruction the anchor
 *   copies into a "subject", and it would arrive outside the markers. Same
 *   boundary id as the content fence — one document, one fence discipline.
 * - Only what is worth stating is stated (spec 1.5.2): confident subjects are
 *   listed as such and uncertain ones marked, and an empty context renders
 *   NOTHING — the input is then byte-identical to the pre-anchoring shape.
 */
function renderDocumentContext(context: SourceContextValue | null, boundary: string): string[] {
  if (!context) return [];
  const lines: string[] = [];
  if (context.subjects.length > 0) {
    const rendered = context.subjects
      .map((subject) => `${subject.name}${subject.confident ? '' : ' (uncertain)'}`)
      .join('; ');
    lines.push(`subjects: ${rendered}`);
  }
  if (context.documentClass) {
    lines.push(
      `document class: ${context.documentClass}${context.documentClassConfident ? '' : ' (uncertain)'}`,
    );
  }
  if (context.revision) {
    lines.push(`revision: ${context.revision}${context.revisionConfident ? '' : ' (uncertain)'}`);
  }
  if (lines.length === 0) return [];
  return ['', 'DOCUMENT CONTEXT:', fenceUntrusted(lines.join('\n'), boundary)];
}

/**
 * Our own framing vocabulary, as it would appear at the start of a line inside
 * the untrusted content. Real prose does not open a line with these; a document
 * that does is imitating the harness (SEC-4 forged framing).
 */
const FORGED_FRAMING_LINE =
  /^[ \t]*(SOURCE CONTENT:|SOURCE TYPE:|REFERENCE TIME|DOCUMENT CONTEXT:)/im;

/**
 * Offset of the first forged framing line in the content, or null when there is
 * none. Everything from here on is suspect.
 */
export function forgedFramingOffset(text: string): number | null {
  const match = FORGED_FRAMING_LINE.exec(text);
  return match ? match.index : null;
}

/**
 * True when the fact's evidence lies ONLY inside the forged region. A span that
 * also occurs before the forgery is legitimate content and is kept: the guard
 * drops what the forgery introduced, not everything in a document that happens
 * to contain one.
 */
export function groundedInForgedFrame(
  fact: CandidateFact,
  chunk: Chunk,
  forgedAt: number | null,
): boolean {
  if (forgedAt === null) return false;
  const span = fact.source_span?.trim();
  if (!span) return false;
  const firstAt = chunk.text.indexOf(span);
  // Not found verbatim: fall back to the claim, which is the model's paraphrase.
  if (firstAt === -1) {
    const forgedRegion = chunk.text.slice(forgedAt);
    return spanOverlapsRegion(fact.claim, forgedRegion);
  }
  return firstAt >= forgedAt;
}

/** Cheap containment test for a paraphrased claim against the forged region. */
function spanOverlapsRegion(claim: string, region: string): boolean {
  const words = claim
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 4);
  if (words.length === 0) return false;
  const haystack = region.toLowerCase();
  const hits = words.filter((w) => haystack.includes(w)).length;
  // A clear majority of the claim's content words come from the forged region.
  return hits / words.length > 0.6;
}

/**
 * Maps an extracted subject onto the context's canonical name (V2.1 item 4.2).
 *
 * Two shapes are canonicalized, both toward a name the DOCUMENT CONTEXT
 * already declares, so this can never invent a subject:
 * - an exact case-insensitive match takes the context's casing;
 * - a ONE-word prefix in front of a declared name ("Model SEN-210", "Modell
 *   X-200", "Project Atlas") drops the prefix, because headings prepend a
 *   common noun to the name and a model copying the heading verbatim would
 *   silently split one product's facts into two subjects.
 * Everything else — including multi-word differences — is left exactly as the
 * model produced it.
 */
export function canonicalizeAnchoredSubject(
  subject: string | null,
  context: SourceContextValue | null,
): string | null {
  if (!subject || !context) return subject;
  const trimmed = subject.trim();
  const lower = trimmed.toLowerCase();
  for (const candidate of context.subjects) {
    const name = candidate.name.trim();
    if (!name) continue;
    const nameLower = name.toLowerCase();
    if (lower === nameLower) return name;
    if (lower.endsWith(` ${nameLower}`)) {
      const prefix = trimmed.slice(0, trimmed.length - name.length).trim();
      if (prefix.length > 0 && !prefix.includes(' ')) return name;
    }
  }
  return subject;
}

/** The metadata labels `buildExtractionInput` prepends — never real fact content. */
const METADATA_LABELS = ['REFERENCE TIME', 'SOURCE TYPE', 'SOURCE CONTENT', 'DOCUMENT CONTEXT'];

/** True when the model spilled a metadata label into the fact (claim, span, or
 * subject) — a provenance leak, not a real fact. */
export function carriesMetadataLabel(fact: CandidateFact): boolean {
  const fields = [fact.claim, fact.source_span, fact.subject_entity ?? ''];
  return fields.some((field) => METADATA_LABELS.some((label) => field.includes(label)));
}
