import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import type {
  ChainVerificationDto,
  IntegrityStatusDto,
  ReceiptDetailDto,
  ReceiptListItem,
} from '@cogeto/shared';
import { DRIZZLE, loadInstancePublicKey } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { deletionReceipt, integrityAlert } from './persistence/tables';
import { verifyChain } from './domain/receipt-chain';
import type { ConfirmedReceipt } from './domain/receipt-chain';
import { INSTANCE_KEY_DIR, parseReceiptCounts } from './deletion-saga';
import { IntegritySweep } from './integrity-sweep';

/**
 * /api/receipts — the Forgotten ledger (§B.1): permanent, read-only records of
 * provable forgetting. There is deliberately NO update or delete route — the
 * database freeze trigger (migration 0010) backs the same rule below the API.
 *
 * Scoping (decision 0009): the ledger shows the caller's own receipts
 * (counts_json.requested_by, which sits inside the signed payload); chain
 * verification always walks ALL confirmed receipts — integrity is instance-wide.
 */
@Controller('receipts')
@UseGuards(BearerAuthGuard)
export class ReceiptsController {
  private publicKeyPem?: string;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(INSTANCE_KEY_DIR) private readonly instanceKeyDir: string,
  ) {}

  @Get('verify')
  async verify(): Promise<ChainVerificationDto> {
    const confirmed = await this.db
      .select()
      .from(deletionReceipt)
      .where(eq(deletionReceipt.status, 'confirmed'));
    const pending = await this.db
      .select({ id: deletionReceipt.id })
      .from(deletionReceipt)
      .where(eq(deletionReceipt.status, 'pending'));

    const receipts: ConfirmedReceipt[] = confirmed.map((row) => ({
      id: row.id,
      source_type: row.sourceType,
      source_id: row.sourceId,
      counts_json: row.countsJson,
      signed_at: row.signedAt?.toISOString() ?? '',
      confirmed_at: row.confirmedAt?.toISOString() ?? '',
      prev_hash: row.prevHash ?? '',
      hash: row.hash ?? '',
      signature: row.signature ?? '',
    }));
    this.publicKeyPem ??= await loadInstancePublicKey(this.instanceKeyDir);
    const result = verifyChain(receipts, this.publicKeyPem);
    return { ...result, pending: pending.length };
  }

  /** The caller's receipts, newest first (enumeration time). */
  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<ReceiptListItem[]> {
    const rows = await this.db
      .select()
      .from(deletionReceipt)
      .where(sql`counts_json->>'requested_by' = ${request.principal.userId}`)
      .orderBy(desc(sql`counts_json->>'enumerated_at'`))
      .limit(200);
    const alerting = await this.alertingReceiptIds();
    return rows.map((row) => this.toListItem(row, alerting));
  }

  @Get(':id')
  async detail(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReceiptDetailDto> {
    const rows = await this.db
      .select()
      .from(deletionReceipt)
      .where(eq(deletionReceipt.id, id))
      .limit(1);
    const row = rows[0];
    const counts = row ? parseReceiptCounts(row.countsJson) : null;
    if (!row || counts?.requested_by !== request.principal.userId) {
      throw new NotFoundException(`receipt ${id} not found`);
    }
    const [alerting, chainTip] = await Promise.all([this.alertingReceiptIds(), this.chainTip()]);
    return {
      ...this.toListItem(row, alerting),
      countsJson: row.countsJson,
      hash: row.hash,
      prevHash: row.prevHash,
      signature: row.signature,
      signedAt: row.signedAt?.toISOString() ?? null,
      // QS-23: stamp the ledger's chain tip onto the exported receipt as an
      // external anchor. A later verify must still contain this tip and show a
      // confirmed count ≥ this one — a dropped receipt moves the tip.
      chainTip,
    };
  }

  /**
   * The chain tip (QS-23): the newest confirmed receipt — the one whose hash no
   * other confirmed receipt references as prev_hash — plus the confirmed count.
   */
  private async chainTip(): Promise<{ hash: string | null; confirmedCount: number }> {
    const confirmed = await this.db
      .select({ hash: deletionReceipt.hash, prevHash: deletionReceipt.prevHash })
      .from(deletionReceipt)
      .where(eq(deletionReceipt.status, 'confirmed'));
    const referenced = new Set(confirmed.map((r) => r.prevHash).filter((h): h is string => !!h));
    const tip = confirmed.find((r) => r.hash && !referenced.has(r.hash));
    return { hash: tip?.hash ?? null, confirmedCount: confirmed.length };
  }

  private toListItem(
    row: typeof deletionReceipt.$inferSelect,
    alerting: Set<string>,
  ): ReceiptListItem {
    const counts = parseReceiptCounts(row.countsJson);
    return {
      id: row.id,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      status: row.status,
      alerting: alerting.has(row.id),
      memoryCount: counts.memory_count,
      objectCount: counts.object_keys.length,
      chatMessagesRedacted: counts.chat_messages_redacted ?? 0,
      requestedAt: counts.enumerated_at,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
    };
  }

  private async alertingReceiptIds(): Promise<Set<string>> {
    const rows = await this.db
      .selectDistinct({ receiptId: integrityAlert.receiptId })
      .from(integrityAlert);
    return new Set(rows.map((r) => r.receiptId).filter((id): id is string => id !== null));
  }
}

/**
 * /api/integrity — the sweep's face in the System view (§A.7 step 4): last run,
 * result, and the open alert list. Alerts are never auto-cleared; they mean a
 * human must look.
 */
@Controller('integrity')
@UseGuards(BearerAuthGuard)
export class IntegrityController {
  constructor(private readonly sweep: IntegritySweep) {}

  @Get()
  async status(): Promise<IntegrityStatusDto> {
    const status = await this.sweep.status();
    return { ...status, alerts: await this.sweep.listAlerts() };
  }
}
