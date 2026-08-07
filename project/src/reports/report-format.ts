import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FINDINGS_REPORT_VERSION } from '@cogeto/shared';

/**
 * The findings-report payload contract (V2.3 item 6.2) — the IN-CODE authority
 * for the format, kept in lockstep with the published JSON Schema in
 * docs/findings-report-schema/<version>/ (the passport discipline: the spec
 * test validates generated payloads against the published schema, so drift
 * fails the build).
 *
 * Two invariants the verification procedure depends on:
 *
 * 1. **Integers only.** No number in the payload may be fractional: rates and
 *    trust metrics travel as decimal STRINGS. The canonical bytes are
 *    reproducible by any JSON tool (`jq -cjS`) only if no number can change
 *    representation in a parse/serialize round trip; integers are the one
 *    numeric shape every implementation agrees on. `assertReportPayloadSafe`
 *    enforces this at emission.
 * 2. **Sanitized text.** Quoted spans are verbatim except ASCII control
 *    characters (other than newline and tab), which are replaced with spaces
 *    at assembly: serializers disagree on escaping them, and none of them are
 *    meaningful evidence.
 *
 * The signature follows the receipt pattern exactly: ed25519 over the ASCII
 * hex sha256 of the canonical payload bytes (sorted keys at every depth,
 * compact separators, UTF-8).
 */

const isoDate = z.string().min(1);

const sourceRefSchema = z.object({
  source_type: z.string(),
  source_id: z.string(),
  name: z.string().nullable(),
  document_class: z.string().nullable(),
  revision: z.string().nullable(),
});
export type ReportSourceRef = z.infer<typeof sourceRefSchema>;

const locatorSchema = z.union([
  z.object({
    kind: z.literal('page'),
    page: z.number().int(),
    tier: z.enum(['text', 'ocr', 'vision']).nullable(),
  }),
  z.object({ kind: z.literal('paragraph'), paragraph: z.number().int() }),
  z.object({
    kind: z.literal('sheet_row'),
    sheet: z.string().nullable(),
    sheet_index: z.number().int(),
    row: z.number().int(),
    cell_range: z.string(),
    columns: z.array(z.string()),
  }),
  z.object({ kind: z.literal('document') }),
]);
export type ReportLocator = z.infer<typeof locatorSchema>;

const spanSchema = z.object({
  /** The verbatim cited passage, in the source's original language, FULL
   * length (the PDF truncates visibly; the JSON never loses text). */
  text: z.string(),
  locators: z.array(locatorSchema).nullable(),
  /** Set when any located page was read by OCR or a vision model: the
   * reliability of the transcription is part of the evidence. */
  recovered_by: z.enum(['ocr', 'vision']).nullable(),
  hedge: z.string().nullable(),
});
export type ReportSpan = z.infer<typeof spanSchema>;

const partySchema = z.object({
  memory_id: z.string(),
  claim: z.string(),
  status: z.string(),
  kind: z.string(),
  valid_from: isoDate.nullable(),
  valid_until: isoDate.nullable(),
  source: sourceRefSchema,
  span: spanSchema.nullable(),
});
export type ReportParty = z.infer<typeof partySchema>;

const findingEventSchema = z.object({
  event: z.string(),
  at: isoDate,
  detail: z.record(z.string(), z.unknown()).nullable(),
});

const findingSchema = z.object({
  id: z.string(),
  detected_at: isoDate,
  /** Which pass found it; null on pre-0048 findings means "not recorded". */
  detected_by: z.string().nullable(),
  state: z.enum(['open', 'resolved']),
  /** True when the finding was resolved once and a later change reintroduced
   * the conflict: a corpus that regressed shows that it regressed. */
  reopened: z.boolean(),
  resolution: z.string().nullable(),
  resolved_at: isoDate.nullable(),
  /** Present when a supersession settled it: the revision responsible. */
  resolved_by_revision: z
    .object({
      source_revision_id: z.string().nullable(),
      successor_source: sourceRefSchema.nullable(),
    })
    .nullable(),
  explanation: z.string().nullable(),
  parties: z.tuple([partySchema, partySchema]),
  history: z.array(findingEventSchema),
});
export type ReportFinding = z.infer<typeof findingSchema>;

const findingGroupSchema = z.object({
  subject: z.string().nullable(),
  findings: z.array(findingSchema),
});

const chainLinkSchema = z.object({
  memory_id: z.string(),
  content: z.string(),
  status: z.string(),
  valid_from: isoDate.nullable(),
  valid_until: isoDate.nullable(),
  recorded_at: isoDate,
  source: sourceRefSchema,
});
export type ReportChainLink = z.infer<typeof chainLinkSchema>;

const suppressedEntrySchema = z.object({
  reason: z.string(),
  fact_content: z.string(),
  span_text: z.string().nullable(),
  locators: z.array(locatorSchema).nullable(),
  verification_verdict: z.string().nullable(),
  source: sourceRefSchema,
  created_at: isoDate,
});
export type ReportSuppressedEntry = z.infer<typeof suppressedEntrySchema>;

const coverageSourceSchema = z.object({
  source: sourceRefSchema,
  first_seen_at: isoDate.nullable(),
  facts: z.number().int(),
  suppressed: z.number().int(),
  read: z
    .object({
      outcome: z.string(),
      reason_code: z.string().nullable(),
      pages_total: z.number().int().nullable(),
      pages_ocr: z.number().int(),
      pages_vision: z.number().int(),
      sheets_truncated: z.number().int(),
      rows_read: z.number().int().nullable(),
      rows_total: z.number().int().nullable(),
    })
    .nullable(),
  gate_refusal: z.object({ reason: z.string(), refused_at: isoDate.nullable() }).nullable(),
});
export type ReportCoverageSource = z.infer<typeof coverageSourceSchema>;

/** Trust metrics travel as decimal strings (see the integers-only invariant). */
const trustMetricsSchema = z.object({
  extraction_precision: z.string().nullable(),
  extraction_recall: z.string().nullable(),
  verification_agreement: z.string().nullable(),
  dedup_accuracy: z.string().nullable(),
  contradiction_recall: z.string().nullable(),
  contradiction_precision: z.string().nullable(),
  supersedes_accuracy: z.string().nullable(),
  supersedes_pairs: z.number().int().nullable(),
  rewrite_accuracy: z.string().nullable(),
});
export type ReportTrustMetrics = z.infer<typeof trustMetricsSchema>;

const scopeSchema = z.object({
  kind: z.enum(['corpus', 'import', 'sources', 'date_range']),
  import_run_id: z.string().nullable(),
  refs: z.array(z.object({ source_type: z.string(), source_id: z.string() })).nullable(),
  from: isoDate.nullable(),
  to: isoDate.nullable(),
});

export const reportPayloadSchema = z.object({
  report: z.object({
    id: z.string(),
    version: z.literal(FINDINGS_REPORT_VERSION),
    generated_at: isoDate,
    locale: z.string(),
    scope: scopeSchema,
    /** Time bounds of the examined material (earliest/latest source seen). */
    date_range: z.object({ from: isoDate.nullable(), to: isoDate.nullable() }),
    previous_report: z.object({ id: z.string(), generated_at: isoDate }).nullable(),
    public_key_endpoint: z.string(),
  }),
  configuration: z.object({
    id: z.string(),
    tiers: z.object({
      pipeline: z.object({ provider: z.string(), model: z.string() }),
      answer: z.object({ provider: z.string(), model: z.string() }),
      embedding: z.object({ provider: z.string(), model: z.string() }),
    }),
    vision: z.object({ provider: z.string(), model: z.string() }).nullable(),
    redaction_enabled: z.boolean(),
    prompt_versions: z.array(z.object({ family: z.string(), version: z.string() })),
    reconcile_config_version: z.number().int(),
    trust_scores: z.object({
      status: z.enum(['published', 'not_published']),
      release: z.string().nullable(),
      matched_configuration_id: z.string().nullable(),
      generated_at: isoDate.nullable(),
      aggregate: trustMetricsSchema.nullable(),
      per_language: z.array(trustMetricsSchema.extend({ language: z.string() })).nullable(),
    }),
  }),
  summary: z.object({
    sources_examined: z.number().int(),
    facts_extracted: z.number().int(),
    findings_open: z.number().int(),
    findings_resolved: z.number().int(),
    resolved_since_previous: z.number().int().nullable(),
    new_since_previous: z.number().int().nullable(),
    reopened_since_previous: z.number().int().nullable(),
    sources_not_fully_read: z.number().int(),
    facts_withheld: z.number().int(),
    superseded_facts: z.number().int(),
    gate_refusals: z.number().int(),
    sensitive_facts_excluded: z.number().int(),
  }),
  coverage: z.object({
    sources: z.array(coverageSourceSchema),
    /** Refs the caller asked for that could not be served, with the reason. */
    skipped_refs: z.array(
      z.object({ source_type: z.string(), source_id: z.string(), reason: z.string() }),
    ),
    /** True when enumeration hit the stated cap; never a silent truncation. */
    scope_truncated: z.boolean(),
    scope_limit: z.number().int(),
    import_counts: z
      .object({
        documents: z.number().int(),
        duplicates_skipped: z.number().int(),
        unreadable: z.number().int(),
        failed: z.number().int(),
        excluded: z.number().int(),
        unsupported: z.number().int(),
      })
      .nullable(),
  }),
  findings: z.object({
    grouping: z.literal('subject_entity'),
    groups: z.array(findingGroupSchema),
  }),
  superseded: z.object({
    chains: z.array(z.object({ links: z.array(chainLinkSchema) })),
    chains_truncated: z.boolean(),
    chains_limit: z.number().int(),
  }),
  suppressed: z.object({
    total: z.number().int(),
    by_reason: z.record(z.string(), z.number().int()),
    entries: z.array(suppressedEntrySchema),
    entries_truncated: z.boolean(),
    entries_limit: z.number().int(),
  }),
});
export type ReportPayload = z.infer<typeof reportPayloadSchema>;

/** The signed artifact: the payload plus the integrity block a verifier needs. */
export const reportArtifactSchema = z.object({
  findings_report_version: z.literal(FINDINGS_REPORT_VERSION),
  payload: reportPayloadSchema,
  integrity: z.object({
    algorithm: z.literal('ed25519'),
    canonicalization: z.literal('sorted-keys-compact-json'),
    payload_sha256: z.string(),
    /** base64 ed25519 signature over the ASCII hex hash string (the receipt
     * convention, so the same documented procedure verifies both). */
    signature: z.string(),
    public_key_pem: z.string(),
    public_key_endpoint: z.string(),
  }),
});
export type ReportArtifact = z.infer<typeof reportArtifactSchema>;

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The bytes of the downloadable JSON artifact: 2-space indent + trailing LF
 * (the passport documentBytes convention — human-readable on disk). */
export function reportArtifactBytes(artifact: ReportArtifact): Buffer {
  return Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

/**
 * The integers-only invariant, enforced at emission: a fractional number
 * anywhere in the payload would make the canonical bytes irreproducible by
 * a third party's JSON tooling.
 */
export function assertReportPayloadSafe(value: unknown, path = '$'): void {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`report payload contains a non-integer number at ${path}: ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertReportPayloadSafe(item, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assertReportPayloadSafe(child, `${path}.${key}`);
    }
  }
}

/** Quoted text is verbatim except control characters serializers disagree on:
 * CR pairs collapse to LF, every other C0/C1/DEL control becomes a space. */
export function sanitizeReportText(text: string): string {
  return (
    text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ')
  );
}

/** A rate as a decimal string with three places, or null: "0.824". The TRUE
 * fraction is what gets rounded, per the trust-honesty rule. */
export function rateString(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return value.toFixed(3);
}
