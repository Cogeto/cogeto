import { createHash } from 'node:crypto';
import { LOCALE_TAGS } from '@cogeto/shared';
import type { PreferredLanguage } from '@cogeto/shared';
import { serverTranslator } from '../infrastructure/index';
import { Composer, MARGIN, PAGE } from './pdf/layout';
import { fmt, PdfFont, PdfWriter } from './pdf/pdf-writer';
import type { ParsedFont } from './pdf/ttf';
import type { ParsedLogo } from './pdf/svg-logo';
import type {
  ReportArtifact,
  ReportFinding,
  ReportLocator,
  ReportPayload,
  ReportSourceRef,
  ReportTrustMetrics,
} from './report-format';

/**
 * The findings report, rendered (V2.3 item 6.2, issue C): a professional
 * engineering document from the SAME payload the JSON artifact carries, so
 * the two formats cannot diverge. Design rules: restrained typography, no
 * decorative colour (the logo keeps its own), quoted evidence visually
 * distinct and correct in black-and-white, tables that survive page breaks,
 * page numbers, a table of contents, and a footer carrying the report
 * identifier and generation date. Every string is a locale key; source spans
 * stay verbatim in their original language, and the report says so.
 */

export interface RenderPdfInput {
  artifact: ReportArtifact;
  fonts: { regular: ParsedFont; bold: ParsedFont };
  logo: ParsedLogo;
}

/** Visible span cap in the PDF; the JSON always carries the full text. */
const SPAN_MAX_CHARS = 1200;
const CELL_MAX_CHARS = 220;

export function renderReportPdf(input: RenderPdfInput): Buffer {
  const payload = input.artifact.payload;
  const locale = asLocale(payload.report.locale);
  const t = serverTranslator(locale, 'report');
  const tag = LOCALE_TAGS[locale];
  const dateFmt = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeZone: 'UTC' });
  const dateTimeFmt = new Intl.DateTimeFormat(tag, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  const numberFmt = new Intl.NumberFormat(tag);
  const n = (value: number) => numberFmt.format(value);
  const d = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : t('value.unknown'));
  const dt = (iso: string | null) => (iso ? dateTimeFmt.format(new Date(iso)) : t('value.unknown'));

  const writer = new PdfWriter({
    width: PAGE.width,
    height: PAGE.height,
    title: t('title'),
    creationDate: new Date(payload.report.generated_at),
    idSeed: `cogeto-findings-report:${payload.report.id}:${payload.report.generated_at}`,
    language: locale,
  });
  const fonts = {
    regular: writer.registerFont(input.fonts.regular),
    bold: writer.registerFont(input.fonts.bold),
  };
  const composer = new Composer(writer, fonts);

  const sourceLabel = (source: ReportSourceRef): string => {
    const name = source.name ?? t('source.unnamed', { type: source.source_type });
    return source.revision
      ? `${name} ${t('source.revision', { revision: source.revision })}`
      : name;
  };
  const locatorLabel = (locators: ReportLocator[] | null): string => {
    if (!locators || locators.length === 0) return t('locator.none');
    return locators
      .map((locator) => {
        if (locator.kind === 'page') {
          const base = t('locator.page', { page: n(locator.page) });
          if (locator.tier === 'ocr') return `${base} ${t('locator.tierOcr')}`;
          if (locator.tier === 'vision') return `${base} ${t('locator.tierVision')}`;
          return base;
        }
        if (locator.kind === 'paragraph')
          return t('locator.paragraph', { paragraph: n(locator.paragraph) });
        if (locator.kind === 'sheet_row') {
          return t('locator.sheetRow', {
            sheet: locator.sheet ?? String(locator.sheet_index + 1),
            range: locator.cell_range,
          });
        }
        return t('locator.document');
      })
      .join('; ');
  };

  // ── Cover ────────────────────────────────────────────────────────────────
  composer.logo(input.logo, MARGIN.left, PAGE.height - 44, 132);
  composer.cursorY = PAGE.height - 150;
  composer.para(t('title'), { size: 24, bold: true, after: 2 });
  composer.para(scopeLabel(payload, t), { size: 12, gray: true, after: 18 });

  composer.keyValue(
    [
      [t('cover.generatedAt'), dt(payload.report.generated_at)],
      [t('cover.reportId'), payload.report.id],
      [t('cover.configuration'), payload.configuration.id],
      [
        t('cover.dateRange'),
        payload.report.date_range.from
          ? t('value.range', {
              from: d(payload.report.date_range.from),
              to: d(payload.report.date_range.to),
            })
          : t('value.empty'),
      ],
      [t('cover.instanceKey'), fingerprint(input.artifact.integrity.public_key_pem)],
    ],
    { labelWidth: 150 },
  );
  composer.spacer(10);

  const s = payload.summary;
  composer.rule();
  composer.para(t('cover.atAGlance'), { size: 10.5, bold: true, after: 8 });
  composer.keyValue(
    [
      [t('summary.sourcesExamined'), n(s.sources_examined)],
      [t('summary.factsExtracted'), n(s.facts_extracted)],
      [t('summary.findingsOpen'), n(s.findings_open)],
      [t('summary.findingsResolved'), n(s.findings_resolved)],
      [t('summary.sourcesNotFullyRead'), n(s.sources_not_fully_read)],
      [t('summary.factsWithheld'), n(s.facts_withheld)],
    ],
    { labelWidth: 220 },
  );
  composer.spacer(6);
  composer.para(t('cover.verifyHint'), { size: 8.5, gray: true });

  // The cover stands alone; the body starts on its own page, which also
  // keeps the TOC's page arithmetic exact (body pages are always >= 1).
  composer.newPage();

  // ── Body sections ────────────────────────────────────────────────────────
  renderProvenance(composer, payload, t, { d, dt, n });
  renderExecutiveSummary(composer, payload, t, { d, dt, n });
  renderCoverage(composer, payload, t, { d, dt, n }, sourceLabel);
  renderFindings(composer, payload, t, { d, dt, n }, sourceLabel, locatorLabel);
  renderSuperseded(composer, payload, t, { d, dt, n }, sourceLabel);
  renderSuppressed(composer, payload, t, { d, dt, n }, sourceLabel);
  renderVerification(composer, input.artifact, t);

  // ── Table of contents (composed last, placed after the cover) ────────────
  const bodyPageCount = writer.pageCount;
  const tocPages = renderToc(writer, composer, fonts, t);
  // Final order: cover, toc, body. Move the toc pages up.
  writer.movePages(bodyPageCount, tocPages, 1);

  // ── Footers with final page numbers ──────────────────────────────────────
  const total = writer.pageCount;
  for (let index = 0; index < total; index += 1) {
    const page = writer.pageAt(index);
    const left = t('footer.reportId', { id: payload.report.id });
    const center = d(payload.report.generated_at);
    const right = t('footer.page', { page: n(index + 1), total: n(total) });
    const size = 7;
    const y = 30;
    page.op(
      `q ${fmt(0.8)} G 0.5 w ${fmt(MARGIN.left)} ${fmt(y + 10)} m ${fmt(
        PAGE.width - MARGIN.right,
      )} ${fmt(y + 10)} l S Q`,
    );
    composer.drawTextOn(page, fonts.regular, size, MARGIN.left, y, left, 0.45);
    const centerWidth = fonts.regular.widthOf(center, size);
    composer.drawTextOn(page, fonts.regular, size, (PAGE.width - centerWidth) / 2, y, center, 0.45);
    const rightWidth = fonts.regular.widthOf(right, size);
    composer.drawTextOn(
      page,
      fonts.regular,
      size,
      PAGE.width - MARGIN.right - rightWidth,
      y,
      right,
      0.45,
    );
  }

  return writer.finalize();
}

type T = ReturnType<typeof serverTranslator>;

/** Enum value → key maps (the AGENTS.md rule: enum values are never
 * translated, only their display names, through explicit maps whose literal
 * keys the i18n check can see). */
const READ_OUTCOME_KEYS: Record<string, string> = {
  read: 'coverage.readOutcome.read',
  truncated: 'coverage.readOutcome.truncated',
  empty: 'coverage.readOutcome.empty',
  unsupported_format: 'coverage.readOutcome.unsupported_format',
  read_failed: 'coverage.readOutcome.read_failed',
  needs_vision: 'coverage.readOutcome.needs_vision',
};
const READ_REASON_KEYS: Record<string, string> = {
  row_cap_sheet: 'coverage.readReason.row_cap_sheet',
  row_cap_file: 'coverage.readReason.row_cap_file',
  no_text: 'coverage.readReason.no_text',
  unsupported_type: 'coverage.readReason.unsupported_type',
  legacy_office_format: 'coverage.readReason.legacy_office_format',
  vision_unavailable: 'coverage.readReason.vision_unavailable',
  vision_cap_reached: 'coverage.readReason.vision_cap_reached',
  vision_failed: 'coverage.readReason.vision_failed',
  no_readable_text: 'coverage.readReason.no_readable_text',
  parse_failed: 'coverage.readReason.parse_failed',
  parse_timeout: 'coverage.readReason.parse_timeout',
  text_over_cap: 'coverage.readReason.text_over_cap',
  undecodable_text: 'coverage.readReason.undecodable_text',
};
const GATE_REASON_KEYS: Record<string, string> = {
  extraction_disabled: 'coverage.gateReason.extraction_disabled',
  source_disabled: 'coverage.gateReason.source_disabled',
  document_class_denied: 'coverage.gateReason.document_class_denied',
};
const SKIP_REASON_KEYS: Record<string, string> = {
  unknown_source_type: 'coverage.skipReason.unknown_source_type',
  not_found_or_not_owned: 'coverage.skipReason.not_found_or_not_owned',
};
const RESOLUTION_KEYS: Record<string, string> = {
  confirmed_a: 'finding.resolutionLabel.confirmed_a',
  confirmed_b: 'finding.resolutionLabel.confirmed_b',
  corrected: 'finding.resolutionLabel.corrected',
  dismissed: 'finding.resolutionLabel.dismissed',
  revision: 'finding.resolutionLabel.revision',
};
const FINDING_EVENT_KEYS: Record<string, string> = {
  party_superseded: 'finding.event.party_superseded',
  resolved_by_user: 'finding.event.resolved_by_user',
  resolved_by_revision: 'finding.event.resolved_by_revision',
  kept_open: 'finding.event.kept_open',
  reopened: 'finding.event.reopened',
};
const RECOVERED_KEYS: Record<string, string> = {
  ocr: 'finding.recovered.ocr',
  vision: 'finding.recovered.vision',
};
const SUPPRESSED_REASON_KEYS: Record<string, string> = {
  hedged_in_source: 'suppressed.reason.hedged_in_source',
  partially_supported: 'suppressed.reason.partially_supported',
  unsupported: 'suppressed.reason.unsupported',
  unjudgeable: 'suppressed.reason.unjudgeable',
  structurally_invalid: 'suppressed.reason.structurally_invalid',
  legacy_unspecified: 'suppressed.reason.legacy_unspecified',
};

/** A stored enum value the map does not know renders as itself: an honest
 * identifier beats a missing-key marker. */
function enumLabel(t: T, keys: Record<string, string>, value: string): string {
  const key = keys[value];
  return key ? t(key) : value;
}
interface Formatters {
  d: (iso: string | null) => string;
  dt: (iso: string | null) => string;
  n: (value: number) => string;
}

function scopeLabel(payload: ReportPayload, t: T): string {
  const scope = payload.report.scope;
  if (scope.kind === 'corpus') return t('scope.corpus');
  if (scope.kind === 'import') return t('scope.import', { id: scope.import_run_id ?? '' });
  if (scope.kind === 'sources') return t('scope.sources', { count: scope.refs?.length ?? 0 });
  return t('scope.dateRange');
}

function fingerprint(pem: string): string {
  const body = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  const digest = createHash('sha256').update(Buffer.from(body, 'base64')).digest('hex');
  return `SHA256:${digest
    .match(/.{1,8}/g)!
    .slice(0, 4)
    .join(' ')}`;
}

function renderProvenance(
  composer: Composer,
  payload: ReportPayload,
  t: T,
  { dt, n }: Formatters,
): void {
  composer.heading(1, t('provenance.heading'));
  composer.para(t('provenance.intro'));
  const rows: [string, string][] = [
    [t('provenance.reportId'), payload.report.id],
    [t('provenance.generatedAt'), dt(payload.report.generated_at)],
    [t('provenance.scope'), scopeLabel(payload, t)],
    [
      t('provenance.previousRun'),
      payload.report.previous_report
        ? t('provenance.previousRunValue', {
            id: payload.report.previous_report.id,
            date: dt(payload.report.previous_report.generated_at),
          })
        : t('provenance.noPreviousRun'),
    ],
    [t('provenance.configurationId'), payload.configuration.id],
    [
      t('provenance.pipelineModel'),
      `${payload.configuration.tiers.pipeline.provider}/${payload.configuration.tiers.pipeline.model}`,
    ],
    [
      t('provenance.embeddingModel'),
      `${payload.configuration.tiers.embedding.provider}/${payload.configuration.tiers.embedding.model}`,
    ],
    [
      t('provenance.visionModel'),
      payload.configuration.vision
        ? `${payload.configuration.vision.provider}/${payload.configuration.vision.model}`
        : t('value.none'),
    ],
    [
      t('provenance.prompts'),
      payload.configuration.prompt_versions.map((p) => `${p.family}/${p.version}`).join(', '),
    ],
    [t('provenance.reconcileConfig'), `v${n(payload.configuration.reconcile_config_version)}`],
  ];
  composer.keyValue(rows, { labelWidth: 175 });

  composer.heading(2, t('trust.heading'));
  const trust = payload.configuration.trust_scores;
  if (trust.status === 'published' && trust.aggregate) {
    composer.para(
      t('trust.published', {
        release: trust.release ?? '',
        configuration: trust.matched_configuration_id ?? '',
      }),
    );
    const notMeasured = t('value.notMeasured');
    const metricRows: string[][] = [];
    const row = (metrics: ReportTrustMetrics, label: string) =>
      metricRows.push([
        label,
        metrics.extraction_precision ?? notMeasured,
        metrics.extraction_recall ?? notMeasured,
        metrics.contradiction_recall ?? notMeasured,
        metrics.contradiction_precision ?? notMeasured,
        metrics.supersedes_accuracy ?? notMeasured,
      ]);
    row(trust.aggregate, t('trust.aggregate'));
    for (const lang of trust.per_language ?? []) row(lang, lang.language);
    composer.table(
      [
        { header: t('trust.column.set'), width: 90 },
        { header: t('trust.column.extractionPrecision'), width: 80 },
        { header: t('trust.column.extractionRecall'), width: 80 },
        { header: t('trust.column.contradictionRecall'), width: 80 },
        { header: t('trust.column.contradictionPrecision'), width: 80 },
        { header: t('trust.column.supersedes'), width: 80 },
      ],
      metricRows,
    );
    composer.para(t('trust.readingNote'), { size: 8, gray: true });
  } else {
    composer.para(t('trust.notPublished', { configuration: payload.configuration.id }));
  }
}

function renderExecutiveSummary(
  composer: Composer,
  payload: ReportPayload,
  t: T,
  { n }: Formatters,
): void {
  const s = payload.summary;
  composer.heading(1, t('executive.heading'));
  composer.para(
    t('executive.examined', {
      sources: n(s.sources_examined),
      facts: n(s.facts_extracted),
    }),
  );
  composer.para(
    t('executive.findings', {
      open: n(s.findings_open),
      resolved: n(s.findings_resolved),
    }),
  );
  if (s.resolved_since_previous !== null) {
    composer.para(
      t('executive.delta', {
        resolved: n(s.resolved_since_previous),
        appeared: n(s.new_since_previous ?? 0),
        reopened: n(s.reopened_since_previous ?? 0),
      }),
    );
  } else {
    composer.para(t('executive.noDelta'));
  }
  composer.para(
    t('executive.limits', {
      notFullyRead: n(s.sources_not_fully_read),
      withheld: n(s.facts_withheld),
      gated: n(s.gate_refusals),
    }),
  );
  if (s.sensitive_facts_excluded > 0) {
    composer.para(t('executive.sensitiveExcluded', { count: s.sensitive_facts_excluded }));
  }
  composer.para(t('executive.superseded', { count: s.superseded_facts }));
}

function renderCoverage(
  composer: Composer,
  payload: ReportPayload,
  t: T,
  { d, n }: Formatters,
  sourceLabel: (source: ReportSourceRef) => string,
): void {
  composer.heading(1, t('coverage.heading'));
  composer.para(t('coverage.intro'));

  if (payload.coverage.scope_truncated) {
    composer.para(t('coverage.scopeTruncated', { limit: n(payload.coverage.scope_limit) }), {
      bold: true,
    });
  }
  if (payload.coverage.import_counts) {
    const ic = payload.coverage.import_counts;
    composer.keyValue(
      [
        [t('coverage.import.documents'), n(ic.documents)],
        [t('coverage.import.duplicates'), n(ic.duplicates_skipped)],
        [t('coverage.import.unreadable'), n(ic.unreadable)],
        [t('coverage.import.failed'), n(ic.failed)],
        [t('coverage.import.excluded'), n(ic.excluded)],
        [t('coverage.import.unsupported'), n(ic.unsupported)],
      ],
      { labelWidth: 220 },
    );
  }

  const problems = payload.coverage.sources.filter(
    (source) =>
      source.gate_refusal !== null || (source.read !== null && source.read.outcome !== 'read'),
  );
  if (problems.length === 0) {
    composer.para(t('coverage.allClean'));
  } else {
    composer.para(t('coverage.problemsIntro', { total: n(problems.length) }));
    composer.table(
      [
        { header: t('coverage.column.document'), width: 150 },
        { header: t('coverage.column.state'), width: 110 },
        { header: t('coverage.column.detail'), width: 220 },
      ],
      problems.map((source) => {
        const read = source.read;
        let state = '';
        let detail = '';
        if (source.gate_refusal) {
          state = t('coverage.state.gated');
          const gateKey = GATE_REASON_KEYS[source.gate_refusal.reason];
          detail = gateKey
            ? t(gateKey, { date: d(source.gate_refusal.refused_at) })
            : source.gate_refusal.reason;
        } else if (read) {
          state = enumLabel(t, READ_OUTCOME_KEYS, read.outcome);
          if (read.outcome === 'truncated') {
            detail = t('coverage.truncatedDetail', {
              read: read.rows_read !== null ? n(read.rows_read) : '',
              total: read.rows_total !== null ? n(read.rows_total) : '',
              sheets: n(read.sheets_truncated),
            });
          } else if (read.reason_code) {
            detail = enumLabel(t, READ_REASON_KEYS, read.reason_code);
          }
        }
        return [clip(sourceLabel(source.source), CELL_MAX_CHARS), state, detail];
      }),
    );
  }

  const recovered = payload.coverage.sources.filter(
    (source) => source.read && (source.read.pages_ocr > 0 || source.read.pages_vision > 0),
  );
  if (recovered.length > 0) {
    composer.para(t('coverage.ocrIntro', { total: n(recovered.length) }));
    composer.table(
      [
        { header: t('coverage.column.document'), width: 200 },
        { header: t('coverage.column.pagesOcr'), width: 90 },
        { header: t('coverage.column.pagesVision'), width: 90 },
      ],
      recovered.map((source) => [
        clip(sourceLabel(source.source), CELL_MAX_CHARS),
        n(source.read!.pages_ocr),
        n(source.read!.pages_vision),
      ]),
    );
  }

  if (payload.coverage.skipped_refs.length > 0) {
    composer.para(t('coverage.skippedIntro', { total: n(payload.coverage.skipped_refs.length) }));
    for (const ref of payload.coverage.skipped_refs) {
      composer.para(
        `${ref.source_type} ${ref.source_id}: ${enumLabel(t, SKIP_REASON_KEYS, ref.reason)}`,
        {
          size: 8.5,
          gray: true,
          indent: 12,
          after: 2,
        },
      );
    }
  }
  composer.para(t('coverage.spanLanguageNote'), { size: 8.5, gray: true });
}

function renderFindings(
  composer: Composer,
  payload: ReportPayload,
  t: T,
  { d, dt, n }: Formatters,
  sourceLabel: (source: ReportSourceRef) => string,
  locatorLabel: (locators: ReportLocator[] | null) => string,
): void {
  composer.heading(1, t('findings.heading'));
  const totalFindings = payload.findings.groups.reduce(
    (sum, group) => sum + group.findings.length,
    0,
  );
  if (totalFindings === 0) {
    composer.para(t('findings.none'));
    return;
  }
  composer.para(t('findings.intro', { total: n(totalFindings) }));
  composer.para(t('findings.groupingNote'), { size: 8.5, gray: true });

  let index = 0;
  for (const group of payload.findings.groups) {
    composer.heading(2, group.subject ?? t('findings.unattributed'));
    for (const finding of group.findings) {
      index += 1;
      renderFinding(composer, finding, index, t, { d, dt, n }, sourceLabel, locatorLabel);
    }
  }
}

function renderFinding(
  composer: Composer,
  finding: ReportFinding,
  index: number,
  t: T,
  { d, dt }: Formatters,
  sourceLabel: (source: ReportSourceRef) => string,
  locatorLabel: (locators: ReportLocator[] | null) => string,
): void {
  const stateLabel =
    finding.state === 'open'
      ? finding.reopened
        ? t('finding.stateReopened')
        : t('finding.stateOpen')
      : enumLabel(t, RESOLUTION_KEYS, finding.resolution ?? 'revision');
  composer.heading(3, t('finding.title', { index }), { toc: false });
  composer.keyValue(
    [
      [t('finding.state'), stateLabel],
      [t('finding.detectedAt'), dt(finding.detected_at)],
      ...(finding.resolved_at
        ? ([[t('finding.resolvedAt'), dt(finding.resolved_at)]] as [string, string][])
        : []),
    ],
    { labelWidth: 130 },
  );
  if (finding.resolved_by_revision?.successor_source) {
    composer.para(
      t('finding.resolvedByRevision', {
        source: sourceLabel(finding.resolved_by_revision.successor_source),
      }),
    );
  }
  if (finding.explanation) {
    composer.para(finding.explanation, { size: 9, gray: true });
  }

  finding.parties.forEach((party, partyIndex) => {
    composer.para(
      t(partyIndex === 0 ? 'finding.claimA' : 'finding.claimB', { claim: party.claim }),
      { bold: true, after: 3 },
    );
    const sourceLine = [
      sourceLabel(party.source),
      locatorLabel(party.span?.locators ?? null),
      t('finding.recordedAt', { date: d(party.valid_from ?? null) }),
    ].join(' · ');
    composer.para(sourceLine, { size: 8.5, gray: true, after: 3 });
    if (party.span?.recovered_by) {
      composer.para(enumLabel(t, RECOVERED_KEYS, party.span.recovered_by), {
        size: 8.5,
        gray: true,
        after: 3,
      });
    }
    if (party.span) {
      composer.quote(party.span.text, {
        maxChars: SPAN_MAX_CHARS,
        truncatedNote: t('finding.spanTruncated'),
      });
      if (party.span.hedge) {
        composer.para(t('finding.hedge', { phrase: party.span.hedge }), {
          size: 8.5,
          gray: true,
          after: 3,
        });
      }
    } else {
      composer.para(t('finding.noSpan'), { size: 8.5, gray: true });
    }
  });

  const relevantHistory = finding.history.filter((event) => event.event !== 'detected');
  if (relevantHistory.length > 0) {
    composer.para(t('finding.historyHeading'), { size: 8.5, bold: true, after: 2 });
    for (const event of relevantHistory) {
      composer.para(`${dt(event.at)}: ${enumLabel(t, FINDING_EVENT_KEYS, event.event)}`, {
        size: 8.5,
        gray: true,
        indent: 12,
        after: 2,
      });
    }
  }
  composer.spacer(6);
  composer.rule();
}

function renderSuperseded(
  composer: Composer,
  payload: ReportPayload,
  t: T,
  { dt, n }: Formatters,
  sourceLabel: (source: ReportSourceRef) => string,
): void {
  composer.heading(1, t('superseded.heading'));
  if (payload.superseded.chains.length === 0) {
    composer.para(t('superseded.none'));
    return;
  }
  composer.para(t('superseded.intro', { total: n(payload.superseded.chains.length) }));
  if (payload.superseded.chains_truncated) {
    composer.para(t('superseded.truncated', { limit: payload.superseded.chains_limit }), {
      bold: true,
    });
  }
  payload.superseded.chains.forEach((chain, chainIndex) => {
    composer.heading(3, t('superseded.chainTitle', { index: chainIndex + 1 }), { toc: false });
    chain.links.forEach((link, linkIndex) => {
      const label =
        linkIndex === chain.links.length - 1
          ? t('superseded.currentBelief')
          : t('superseded.replacedBelief');
      composer.para(`${label}: ${link.content}`, {
        bold: linkIndex === chain.links.length - 1,
        indent: 12,
        after: 2,
      });
      composer.para(
        `${sourceLabel(link.source)} · ${t('superseded.recorded', { date: dt(link.recorded_at) })}${
          link.valid_until ? ` · ${t('superseded.validUntil', { date: dt(link.valid_until) })}` : ''
        }`,
        { size: 8.5, gray: true, indent: 12, after: 6 },
      );
    });
    composer.spacer(4);
  });
}

function renderSuppressed(
  composer: Composer,
  payload: ReportPayload,
  t: T,
  { d, n }: Formatters,
  sourceLabel: (source: ReportSourceRef) => string,
): void {
  composer.heading(1, t('suppressed.heading'));
  composer.para(t('suppressed.intro', { total: n(payload.suppressed.total) }));
  if (payload.suppressed.total === 0) return;

  composer.table(
    [
      { header: t('suppressed.column.reason'), width: 200 },
      { header: t('suppressed.column.count'), width: 80 },
    ],
    Object.entries(payload.suppressed.by_reason).map(([reason, count]) => [
      enumLabel(t, SUPPRESSED_REASON_KEYS, reason),
      n(count),
    ]),
  );
  if (payload.suppressed.entries.length > 0) {
    composer.para(
      payload.suppressed.entries_truncated
        ? t('suppressed.entriesTruncated', {
            shown: n(payload.suppressed.entries.length),
            limit: n(payload.suppressed.entries_limit),
          })
        : t('suppressed.entriesIntro'),
      { size: 8.5, gray: true },
    );
    composer.table(
      [
        { header: t('suppressed.column.fact'), width: 220 },
        { header: t('suppressed.column.reason'), width: 90 },
        { header: t('suppressed.column.document'), width: 120 },
        { header: t('suppressed.column.date'), width: 70 },
      ],
      payload.suppressed.entries.map((entry) => [
        clip(entry.fact_content, CELL_MAX_CHARS),
        enumLabel(t, SUPPRESSED_REASON_KEYS, entry.reason),
        clip(sourceLabel(entry.source), 120),
        d(entry.created_at),
      ]),
    );
  }
}

function renderVerification(composer: Composer, artifact: ReportArtifact, t: T): void {
  composer.heading(1, t('verify.heading'));
  composer.para(t('verify.intro'));
  composer.keyValue(
    [
      [t('verify.reportId'), artifact.payload.report.id],
      [t('verify.hash'), artifact.integrity.payload_sha256],
      [t('verify.signature'), artifact.integrity.signature],
      [t('verify.keyFingerprint'), fingerprint(artifact.integrity.public_key_pem)],
      [t('verify.keyEndpoint'), artifact.integrity.public_key_endpoint],
    ],
    { labelWidth: 150 },
  );
  composer.para(t('verify.step1'), { indent: 12, after: 3 });
  composer.para(t('verify.step2'), { indent: 12, after: 3 });
  composer.para(t('verify.step3'), { indent: 12, after: 3 });
  composer.para(t('verify.step4'), { indent: 12, after: 3 });
  composer.para(t('verify.commands'), { size: 8, gray: true, after: 3 });
  composer.para(
    'jq -cjS .payload report.json | shasum -a 256\n' +
      'jq -r .integrity.public_key_pem report.json > pub.pem\n' +
      'jq -r .integrity.signature report.json | base64 -d > sig.bin\n' +
      'printf %s <payload_sha256> > hash.txt\n' +
      'openssl pkeyutl -verify -pubin -inkey pub.pem -rawin -in hash.txt -sigfile sig.bin',
    { size: 7.5, indent: 12, lineHeight: 1.5 },
  );
  composer.para(t('verify.pdfNote'), { size: 8.5, gray: true });
}

function renderToc(
  writer: PdfWriter,
  composer: Composer,
  fonts: { regular: PdfFont; bold: PdfFont },
  t: T,
): number {
  const entries = composer.toc;
  const lineHeight = 16;
  const capacity = Math.floor((PAGE.height - MARGIN.top - MARGIN.bottom - 60) / lineHeight);
  const tocPageCount = Math.max(1, Math.ceil(entries.length / capacity));

  let page = writer.addPage();
  let pagesAdded = 1;
  let y = PAGE.height - MARGIN.top;
  composer.drawTextOn(page, fonts.bold, 15, MARGIN.left, y - 15, t('toc.heading'), 0);
  y -= 42;
  let onPage = 0;
  for (const entry of entries) {
    if (onPage >= capacity) {
      page = writer.addPage();
      pagesAdded += 1;
      y = PAGE.height - MARGIN.top;
      onPage = 0;
    }
    // Body pages sit after the cover (1 page) and the TOC itself.
    const target = entry.pageIndex + 1 + tocPageCount;
    const size = entry.level === 1 ? 10 : 9;
    const font = entry.level === 1 ? fonts.bold : fonts.regular;
    const indent = entry.level === 1 ? 0 : 14;
    const label = clip(entry.title, 90);
    const pageLabel = String(target);
    composer.drawTextOn(page, font, size, MARGIN.left + indent, y - size, label, 0);
    const pageWidth = fonts.regular.widthOf(pageLabel, size);
    composer.drawTextOn(
      page,
      fonts.regular,
      size,
      PAGE.width - MARGIN.right - pageWidth,
      y - size,
      pageLabel,
      0,
    );
    // Dot leader between title and page number.
    const titleEnd = MARGIN.left + indent + font.widthOf(label, size) + 6;
    const leaderEnd = PAGE.width - MARGIN.right - pageWidth - 6;
    if (leaderEnd > titleEnd + 10) {
      page.op(
        `q 0.6 G 0.5 w [1 3] 0 d ${fmt(titleEnd)} ${fmt(y - size + 2)} m ${fmt(leaderEnd)} ${fmt(
          y - size + 2,
        )} l S Q`,
      );
    }
    y -= lineHeight;
    onPage += 1;
  }
  return pagesAdded;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function asLocale(locale: string): PreferredLanguage {
  return (['en', 'hr', 'de', 'fr'] as const).includes(locale as PreferredLanguage)
    ? (locale as PreferredLanguage)
    : 'en';
}
