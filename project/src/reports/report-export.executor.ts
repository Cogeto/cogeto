import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import { DRIZZLE, loadInstanceSigner, writeAudit } from '../infrastructure/index';
import type { Db, InstanceSigner } from '../infrastructure/index';
import { canonicalize, MemoryObjectStore } from '../memory/index';
import { UserDirectory } from '../identity/index';
import { ReportAssembler } from './report-assembler';
import {
  assertReportPayloadSafe,
  reportArtifactBytes,
  reportPayloadSchema,
  sha256Hex,
  type ReportArtifact,
} from './report-format';
import { renderReportPdf } from './report-pdf';
import { parseTtf, type ParsedFont } from './pdf/ttf';
import { parseLogoSvg, type ParsedLogo } from './pdf/svg-logo';
import { ReportStore } from './report.store';
import { REPORT_OPTIONS } from './report.options';
import type { ReportOptions } from './report.options';

/** Owner principal reconstructed from the run row — generation re-reads
 * through the SAME gated interfaces, so a report can only ever contain what
 * this user may see (the passport contract, applied to the second artifact). */
function ownerPrincipal(userId: string, orgId: string | null): Principal {
  return { userId, name: '', email: null, orgId: orgId ?? '', orgName: '', roles: [] };
}

/**
 * The findings-report generation job (V2.3 item 6.2) — worker-run because a
 * large corpus takes time (spec §15.4). Assembles the payload through gated
 * reads, validates it against the format contract, signs the canonical hash
 * with the instance key (the receipt convention), renders the PDF from the
 * same payload, and publishes both artifacts under the passport's SEC-8 race
 * guard.
 */
@Injectable()
export class ReportExportExecutor {
  private readonly logger = new Logger(ReportExportExecutor.name);
  private signer?: InstanceSigner;
  private fonts?: { regular: ParsedFont; bold: ParsedFont };
  private logo?: ParsedLogo;

  constructor(
    private readonly store: ReportStore,
    private readonly assembler: ReportAssembler,
    private readonly objects: MemoryObjectStore,
    private readonly directory: UserDirectory,
    @Inject(REPORT_OPTIONS) private readonly options: ReportOptions,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  /** Generate and publish one run. Idempotent: a retry overwrites the same
   * object keys and re-marks the row ready. */
  async run(reportId: string, now: Date): Promise<{ published: boolean }> {
    const run = await this.store.getById(reportId);
    if (!run) throw new Error(`findings report ${reportId} not found`);
    if (run.status !== 'pending' && run.status !== 'running') {
      // Expired by a deletion or already settled: nothing to do, honestly.
      this.logger.log(`findings report ${reportId} is ${run.status}: generation skipped`);
      return { published: false };
    }
    const principal = ownerPrincipal(run.userId, run.orgId);

    await this.store.reportProgress(reportId, { stage: 'enumerating', done: 0, total: 0 });
    const previous = await this.store.previousReady(
      run.userId,
      run.scopeKey,
      run.createdAt,
      run.id,
    );
    const { payload, counts } = await this.assembler.assemble(
      principal,
      run,
      previous,
      async (done, total) => {
        await this.store.reportProgress(reportId, { stage: 'assembling', done, total });
      },
    );

    // The format contract is enforced on every generated payload, not only in
    // tests: an invalid report must fail loudly, never ship quietly.
    const parsed = reportPayloadSchema.parse(payload);
    assertReportPayloadSafe(parsed);

    await this.store.reportProgress(reportId, { stage: 'signing', done: 0, total: 0 });
    const signer = await this.getSigner();
    const payloadSha256 = sha256Hex(Buffer.from(canonicalize(parsed), 'utf8'));
    const signature = signer.sign(payloadSha256);
    const artifact: ReportArtifact = {
      findings_report_version: parsed.report.version,
      payload: parsed,
      integrity: {
        algorithm: 'ed25519',
        canonicalization: 'sorted-keys-compact-json',
        payload_sha256: payloadSha256,
        signature,
        public_key_pem: signer.publicKeyPem,
        public_key_endpoint: parsed.report.public_key_endpoint,
      },
    };
    const jsonBytes = reportArtifactBytes(artifact);

    await this.store.reportProgress(reportId, { stage: 'rendering', done: 0, total: 0 });
    const pdfBytes = renderReportPdf({
      artifact,
      fonts: await this.getFonts(),
      logo: await this.getLogo(),
    });

    await this.store.reportProgress(reportId, { stage: 'uploading', done: 0, total: 0 });
    const jsonKey = this.objectKeyFor(principal, reportId, 'json');
    const pdfKey = this.objectKeyFor(principal, reportId, 'pdf');
    await this.objects.putObject(jsonKey, jsonBytes, { contentType: 'application/json' });
    await this.objects.putObject(pdfKey, pdfBytes, { contentType: 'application/pdf' });

    const expiresAt = new Date(now.getTime() + this.options.exportRetentionHours * 3_600_000);
    const published = await this.store.markReady(reportId, {
      jsonObjectKey: jsonKey,
      pdfObjectKey: pdfKey,
      jsonSizeBytes: jsonBytes.length,
      pdfSizeBytes: pdfBytes.length,
      payloadSha256,
      signature,
      modelConfigId: this.options.modelConfig.id,
      counts,
      previousReportId: previous?.id ?? null,
      readyAt: now,
      expiresAt,
    });
    if (!published) {
      // The SEC-8 race, verbatim from the passport: a source deletion expired
      // this run while we were assembling, so the artifacts we just wrote
      // quote content a receipt already promised erased. They were written
      // after the saga enumerated, so no receipt names them: erase them here.
      await this.objects.deleteObject(jsonKey);
      await this.objects.deleteObject(pdfKey);
      this.logger.log(
        `findings report ${reportId} was expired by a source deletion while assembling: ` +
          `artifacts discarded, report not published`,
      );
      return { published: false };
    }
    await writeAudit(this.db, {
      actor: 'findings_report',
      action: 'report.ready',
      entityType: 'findings_report',
      entityId: reportId,
      detail: {
        pdfSizeBytes: pdfBytes.length,
        jsonSizeBytes: jsonBytes.length,
        expiresAt: expiresAt.toISOString(),
        findingsOpen: counts.findingsOpen,
        sourcesExamined: counts.sourcesExamined,
      },
      orgId: (await this.directory.orgOf(run.userId)) ?? undefined,
      ownerId: run.userId,
    });
    this.logger.log(
      `findings report ${reportId} ready: ${counts.sourcesExamined} sources, ` +
        `${counts.findingsOpen} open findings, ${pdfBytes.length} pdf bytes`,
    );
    return { published: true };
  }

  /** Mark a run failed (visible in the run list) — the job handler's error
   * path before graphile retries. */
  async fail(reportId: string, message: string): Promise<void> {
    await this.store.markFailed(reportId, message);
  }

  /** The hourly retention pass: delete artifacts past their expiry and flip
   * the row to expired. The row and its counts stay — the delta needs them. */
  async runRetention(now: Date): Promise<number> {
    const expired = await this.store.listExpired(now);
    for (const row of expired) {
      if (row.jsonObjectKey) await this.objects.deleteObject(row.jsonObjectKey);
      if (row.pdfObjectKey) await this.objects.deleteObject(row.pdfObjectKey);
      await this.store.markExpired(row.id);
    }
    return expired.length;
  }

  private objectKeyFor(principal: Principal, reportId: string, format: 'json' | 'pdf'): string {
    const org = principal.orgId || 'instance';
    // Under exports/ deliberately: the integrity sweep excludes that prefix
    // from the orphan scan exactly as it does for passports.
    return `${org}/${principal.userId}/exports/findings-report-${reportId}.${format}`;
  }

  private async getSigner(): Promise<InstanceSigner> {
    this.signer ??= await loadInstanceSigner(this.options.instanceKeyDir);
    return this.signer;
  }

  private async getFonts(): Promise<{ regular: ParsedFont; bold: ParsedFont }> {
    if (!this.fonts) {
      const [regular, bold] = await Promise.all([
        readFile(join(this.options.fontsDir, 'DejaVuSans.ttf')),
        readFile(join(this.options.fontsDir, 'DejaVuSans-Bold.ttf')),
      ]);
      this.fonts = { regular: parseTtf(regular), bold: parseTtf(bold) };
    }
    return this.fonts;
  }

  private async getLogo(): Promise<ParsedLogo> {
    if (!this.logo) {
      // The single-color variant: the brand README designates it for print
      // and monochrome contexts, which a findings report is.
      const svg = await readFile(join(this.options.brandDir, 'cogeto-final-logo-mono.svg'), 'utf8');
      this.logo = parseLogoSvg(svg);
    }
    return this.logo;
  }
}
