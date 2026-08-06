import { Inject, Injectable, Optional } from '@nestjs/common';
import { DEFAULT_INSTANCE_TIMEZONE, INSTANCE_TIMEZONE } from '../../infrastructure/index';
import type { Tx } from '../../infrastructure/index';
import { MemoryStore } from '../../memory/index';
import type { MemoryRow } from '../../memory/index';
import { ModelGateway } from '../../model-gateway/index';
import { locateSpan } from '@cogeto/shared';
import type { ReadLocator, UncertaintyReason } from '@cogeto/shared';
import { resolveFactTemporal } from '../domain/candidate-fact';
import { classifyAdmission } from '../domain/uncertainty';
import { SuppressedFactLog } from '../persistence/suppressed-fact-log';
import type { SuppressedFactEntry } from '../persistence/suppressed-fact-log';
import { verificationResult } from '../persistence/tables';
import type { SourceItem } from './source-reader';
import type { VerifiedFact } from './verify.stage';

export interface AdmittedMemory {
  memoryId: string;
  status: 'active' | 'uncertain';
  /** The taxonomy arm this fact landed on; null when it was admitted active. */
  uncertaintyReason: UncertaintyReason | null;
  /** The committed-in-tx row and its stage-5 embedding — stage 6's input. */
  row: MemoryRow;
  embedding: number[];
}

/**
 * Stage 5 (embed + store), real: each verified fact is embedded and
 * persisted in the same step (glossary; supersedes 0004 ruling 1's stage-4
 * admission). Order inside the job's idempotency
 * transaction
 *
 *   1. one batched embed call for all claims (model work before any write);
 *   2. Postgres rows — memory (status per the spec §2 verdict, embedding_model
 *      recorded) + verification_result, inside `tx`;
 *   3. Qdrant points LAST, id = memory id.
 *
 * Two-store safety: a failed point write throws → `tx` rolls back the rows and
 * the job retries — never a duplicate row. Points written before the failure
 * can survive as orphans (ids that no longer exist in Postgres); they are
 * invisible to reads (hits are resolved through gated Postgres reads) and are
 * swept by reindex / the spec §11.1 nightly job. Postgres stays the source of truth.
 */
@Injectable()
export class EmbedStoreStage {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly memoryStore: MemoryStore,
    /** Records every automatic demotion, in THIS transaction (V2.0 item 3.3). */
    private readonly suppressedFacts: SuppressedFactLog,
    // The instance timezone for relative-date resolution; @Optional so
    // bare/test builds fall back to the default without wiring LimitsModule.
    @Optional()
    @Inject(INSTANCE_TIMEZONE)
    private readonly timeZone: string = DEFAULT_INSTANCE_TIMEZONE,
  ) {}

  async run(
    tx: Tx,
    source: SourceItem,
    verified: VerifiedFact[],
    options: {
      /**
       * Gate retention (V2.1 item 4.3): facts from this source's gate live this
       * many days from ADMISSION (not from the source's own timestamp — an old
       * email ingested today would otherwise expire on arrival). Applied only
       * when the extractor resolved no `valid_until` of its own: a fact's own
       * stated validity always outranks a blanket policy. Lapse is then the
       * dreaming staleness pass's existing job (`active` → `outdated`); nothing
       * is deleted and history is never destroyed.
       */
      retentionDays?: number | null;
    } = {},
  ): Promise<AdmittedMemory[]> {
    if (verified.length === 0) return [];
    const retentionUntil =
      options.retentionDays != null
        ? new Date(Date.now() + options.retentionDays * 24 * 3_600_000)
        : null;

    const embeddings = await this.gateway.embed(verified.map((v) => v.fact.claim));
    const embeddingModel = this.gateway.embeddingModelId();

    const rows: MemoryRow[] = [];
    const admitted: AdmittedMemory[] = [];
    const suppressed: SuppressedFactEntry[] = [];
    for (const [
      i,
      { fact, verdict, reason, promptVersion, judged, spanLocatable },
    ] of verified.entries()) {
      // Admission (V2.0 item 3.3): the taxonomy decides, and it decides alone —
      // no queue, no approval, no human step. The rule it encodes is the one
      // that was here before it (active ONLY when the source stated the claim
      // plainly AND the verifier supported it); what is new is that the
      // uncertain arm now names WHY.
      const { status, reason: uncertaintyReason } = classifyAdmission({
        verdict,
        judged,
        hedged: fact.hedged,
        spanLocatable,
      });
      // Dates are resolved by code against the note anchor (
      // ruling 1); v0001 still passes through its pre-resolved fields.
      const { validFrom, validUntil, unresolved } = resolveFactTemporal(
        fact,
        source.createdAt,
        this.timeZone,
      );
      const row = await this.memoryStore.admitExtractedFact(tx, source.ownerId, {
        content: fact.claim,
        // Notes are private in v1 (§4); file uploads inherit the upload's
        // scope selector and sensitive checkbox (F1 handoff). The source item
        // carries both — absent means the note default.
        scope: source.scope ?? 'private',
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        entities: flattenEntities(fact),
        subjectEntity: fact.subject_entity ?? undefined,
        kind: fact.kind,
        // Email-path authorship — carried from the SourceReader,
        // structural, never a model judgment.
        authoredByUser: source.authoredByUser,
        sensitive: source.sensitive ?? false,
        validFrom,
        validUntil: validUntil ?? retentionUntil ?? undefined,
        temporalUnresolved: unresolved,
        initialStatus: status,
        uncertaintyReason: uncertaintyReason ?? undefined,
        embeddingModel,
      });
      // The span is resolved to its structured locators ONCE, here, where the
      // reader's segments are still in hand (V2.2 item 5.2): a discard-mode
      // original cannot be re-read later, and re-parsing a document per page
      // view to say where a fact came from would be absurd. `[]` is stored as
      // NULL: locateSpan's honest "cannot say where" and a source with no
      // segments (notes, chat, email, web) both render as no location.
      const locators = this.locate(source, fact.source_span);
      await tx.insert(verificationResult).values({
        memoryId: row.id,
        verdict,
        reason,
        promptVersion,
        sourceSpan: fact.source_span,
        hedgePhrase: fact.hedged ? fact.hedge_phrase : null,
        spanLocators: locators,
      });
      // Every demotion is logged, with the memory id, because the fact WAS
      // admitted: inspectable in Sources and explained here. Nothing is lost and
      // nothing waits for a person.
      if (uncertaintyReason) {
        suppressed.push({
          ownerId: source.ownerId,
          scope: source.scope ?? 'private',
          sensitive: source.sensitive ?? false,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          factContent: fact.claim,
          factKind: fact.kind,
          sourceSpan: fact.source_span,
          reason: uncertaintyReason,
          verificationVerdict: verdict,
          verificationReason: reason,
          promptVersion,
          memoryId: row.id,
          spanLocators: locators,
        });
      }
      rows.push(row);
      admitted.push({
        memoryId: row.id,
        status,
        uncertaintyReason,
        row,
        embedding: embeddings[i]!,
      });
    }

    await this.suppressedFacts.record(tx, suppressed);
    await this.memoryStore.upsertVectors(rows, embeddings);
    return admitted;
  }

  /** A span's locators, or null when the source has none or none were found. */
  private locate(source: SourceItem, span: string): ReadLocator[] | null {
    if (!source.segments || source.segments.length === 0) return null;
    const found = locateSpan(source.content, source.segments, span);
    return found.length > 0 ? found : null;
  }
}

/**
 * The memory row stores entities flat: people,
 * organizations and projects in one deduplicated array, names exactly as the
 * extractor preserved them from the source.
 */
export function flattenEntities(fact: VerifiedFact['fact']): string[] {
  const flat = [...fact.entities.people, ...fact.entities.organizations, ...fact.entities.projects]
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return [...new Set(flat)];
}
