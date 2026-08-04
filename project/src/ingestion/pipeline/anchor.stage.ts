import { Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import type { Tx } from '../../infrastructure/index';
import {
  fenceUntrusted,
  loadPrompt,
  ModelGateway,
  untrustedBoundary,
} from '../../model-gateway/index';
import type { PromptArtifact } from '../../model-gateway/index';
import { ANCHORING_PROMPT } from '../prompt-versions';
import { SourceContextStore } from '../persistence/source-context.store';
import type { SourceContextValue } from '../persistence/source-context.store';
import type { SourceContextRow } from '../persistence/tables';
import { noopLog } from './pipeline-log';
import type { PipelineLog } from './pipeline-log';
import type { SourceItem } from './source-reader';

/**
 * Stage 1.6 — the anchor (V2.1 item 4.2, spec 1.5): before chunking, one cheap
 * pipeline-tier call over the document's OPENING plus its filename produces
 * the source context: what the document as a whole is about (subject
 * entities), what kind of document it is, and which revision. Stored on the
 * source and injected into every chunk's extraction call, so a chunk saying
 * only "Device has one antenna" extracts as a fact about model AAA rather
 * than about "device".
 *
 * Three rules the stage keeps, all from the spec:
 * - A user-edited context is authoritative (spec 1.5.3): the model is not
 *   called and the stored row is used verbatim.
 * - Anchoring only reduces ambiguity (spec 1.5.2): a failed anchor call
 *   degrades to no context — exactly today's behaviour — and never fails the
 *   pipeline run.
 * - File sources only for now: notes, chat, email bodies and web pages state
 *   their subjects inline; documents are where a title block far from a chunk
 *   is the only place the subject was ever written.
 */

/** The opening the anchor reads: title block, headers, first pages. */
export const ANCHOR_OPENING_CHARS = 6000;

const anchorOutputSchema = z.object({
  subjects: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        confident: z.boolean(),
      }),
    )
    .max(12)
    .default([]),
  document_class: z
    .object({ value: z.string().min(1).max(60), confident: z.boolean() })
    .nullable()
    .default(null),
  revision: z
    .object({ value: z.string().min(1).max(60), confident: z.boolean() })
    .nullable()
    .default(null),
});

/**
 * The anchor call itself, storage-free so the eval harness can run the real
 * chain (anchor → extract) without a database. Names are flattened to single
 * lines: they travel into a labeled prompt block later, and a newline inside
 * one would be a place to smuggle framing.
 */
export async function computeSourceContext(
  gateway: ModelGateway,
  promptContent: string,
  document: { content: string; filename?: string },
): Promise<SourceContextValue> {
  const boundary = untrustedBoundary();
  const opening = document.content.slice(0, ANCHOR_OPENING_CHARS);
  const input = [
    `FILENAME: ${sanitizeLine(document.filename) || '(none)'}`,
    '',
    'DOCUMENT OPENING:',
    fenceUntrusted(opening, boundary),
  ].join('\n');
  const output = await gateway.extractStructured(anchorOutputSchema, {
    system: promptContent,
    input,
  });
  const seen = new Set<string>();
  const subjects = output.subjects
    .map((subject) => ({
      name: canonicalSubjectName(sanitizeLine(subject.name)),
      confident: subject.confident,
    }))
    .filter((subject) => {
      if (!subject.name) return false;
      const key = subject.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    subjects,
    documentClass: output.document_class ? sanitizeLine(output.document_class.value) : null,
    documentClassConfident: output.document_class?.confident ?? false,
    revision: output.revision ? sanitizeLine(output.revision.value) : null,
    revisionConfident: output.revision?.confident ?? false,
  };
}

/** One line, trimmed: a context value never carries its own line breaks. */
function sanitizeLine(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * A heading's label word is not part of a product name. Both models involved
 * proved willing to copy "Model SEN-210" verbatim off a section heading (the
 * anchor in Croatian, the extractor in two prompt-wording rounds), so — the
 * SEC-4 lesson again — the last word is code: a TWO-word subject whose second
 * word is product-code shaped (letters AND digits: SEN-210, PWR-3100, A320)
 * and whose first word is a plain label (no digits) canonicalizes to the code.
 * "Model 3", "Boeing 747" and "Office 365" keep their label (the tail has no
 * letter); series names of three words or more are left whole.
 */
function canonicalSubjectName(name: string): string {
  const parts = name.split(' ');
  if (parts.length !== 2) return name;
  const [label, code] = parts as [string, string];
  if (!/\d/.test(label) && /\p{L}/u.test(code) && /\d/.test(code)) return code;
  return name;
}

export function contextValueOf(row: SourceContextRow): SourceContextValue {
  return {
    subjects: row.subjects,
    documentClass: row.documentClass,
    documentClassConfident: row.documentClassConfident,
    revision: row.revision,
    revisionConfident: row.revisionConfident,
  };
}

@Injectable()
export class AnchorStage {
  private prompt?: PromptArtifact;

  constructor(
    private readonly gateway: ModelGateway,
    /** Optional so bare harnesses without the store still run (no persistence,
     * fresh anchor per run — which is what the eval harness wants anyway). */
    @Optional() private readonly store?: SourceContextStore,
  ) {}

  async run(
    tx: Tx,
    source: SourceItem,
    log: PipelineLog = noopLog,
  ): Promise<SourceContextValue | null> {
    if (source.sourceType !== 'file') return null;
    if (source.content.trim().length === 0) return null;

    const stored = this.store ? await this.store.get(tx, source.sourceType, source.sourceId) : null;
    if (stored?.editedByUser) return contextValueOf(stored);

    try {
      const prompt = await this.getPrompt();
      const context = await computeSourceContext(this.gateway, prompt.content, {
        content: source.content,
        filename: source.filename,
      });
      if (this.store) {
        await this.store.recordMachine(tx, {
          ownerId: source.ownerId,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          context,
          promptVersion: `${ANCHORING_PROMPT.family}/${ANCHORING_PROMPT.version}`,
        });
      }
      return context;
    } catch (error) {
      // Spec 1.5.2: anchoring reduces ambiguity, never blocks. A failed anchor
      // call degrades to the stored machine context if one exists, else to no
      // context at all — byte-identical to pre-anchoring extraction.
      log(
        {
          stage: 'anchor',
          source_type: source.sourceType,
          source_id: source.sourceId,
          failed: true,
          reason: error instanceof Error ? error.message : String(error),
        },
        'anchor call failed; extraction proceeds without a document context',
      );
      return stored ? contextValueOf(stored) : null;
    }
  }

  private async getPrompt(): Promise<PromptArtifact> {
    this.prompt ??= await loadPrompt(ANCHORING_PROMPT.family, ANCHORING_PROMPT.version);
    return this.prompt;
  }
}
