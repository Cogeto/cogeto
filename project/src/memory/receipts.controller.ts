import {
  Controller,
  Get,
  Inject,
  Optional,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { resolveSpaceId } from '@cogeto/shared';
import type {
  ChainVerificationDto,
  IntegrityStatusDto,
  ReceiptDetailDto,
  ReceiptListItem,
} from '@cogeto/shared';
import { DRIZZLE, loadInstancePublicKey, userError } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { AdminGuard, BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { deletionReceipt, integrityAlert } from './persistence/tables';
import { verifyChain } from './domain/receipt-chain';
import type { ConfirmedReceipt } from './domain/receipt-chain';
import { INSTANCE_KEY_DIR, parseReceiptCounts } from './deletion-saga';
import { IntegritySweep } from './integrity-sweep';

/**
 * The project role that unlocks the instance-wide chain report
 * (V2.0 item 3.7). Bound by each composition root from its own configuration.
 */
export const RECEIPTS_ADMIN_ROLE = Symbol('RECEIPTS_ADMIN_ROLE');

/**
 * /api/receipts — the Forgotten ledger (spec §11.1): permanent, read-only records of
 * provable forgetting. There is deliberately NO update or delete route — the
 * database freeze trigger (migration 0010) backs the same rule below the API.
 *
 * Scoping: the ledger shows the caller's own receipts
 * (counts_json.requested_by, which sits inside the signed payload) in the
 * caller's current SPACE; chain verification walks that space's whole chain.
 * The chain is per space (docs/features/spaces.md section 5 as amended): a
 * space's chain is the whole a receipt in it can reference, so the space walk
 * verifies everything those receipts can prove.
 */
@Controller('receipts')
@UseGuards(BearerAuthGuard)
export class ReceiptsController {
  private publicKeyPem?: string;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(INSTANCE_KEY_DIR) private readonly instanceKeyDir: string,
    /**
     * The role name that unlocks the instance-wide report. Declared by THIS
     * module and passed by the composition root, not read out of the identity
     * seam's options bag: `IDENTITY_OPTIONS` is deliberately DI-visible and
     * import-invisible (boundary contract §4), and a module that names the
     * field it needs is the pattern item 3.6 part 2 established. Optional so a
     * bare harness boots, and it then sees the trimmed answer, which is the
     * safe direction.
     */
    @Optional() @Inject(RECEIPTS_ADMIN_ROLE) private readonly adminRole?: string,
  ) {}

  /**
   * Verify the chain. The WALK is always space-wide — one chain per space
   * (docs/features/spaces.md section 5 as amended), and a per-user subset of
   * a hash chain still verifies nothing, so the walk covers the whole chain
   * the caller's current space owns — but what comes back is scoped to what
   * the caller is entitled to (V2.0 item 3.7).
   *
   * Before this, any authenticated user got the instance-wide confirmed and
   * pending counts plus the first failure string, which names a receipt id: the
   * same class of cross-user operational data that made `/api/integrity` and
   * `/api/jobs` admin-gated. It is not admin-gated outright because the pill it
   * feeds is on the user's own Forgotten ledger, and "the chain your receipts
   * live in verifies" is exactly the guarantee this product sells. So the
   * VERDICT stays for everyone and the NUMBERS narrow to the caller's own
   * receipts; the error string is operator detail and goes.
   *
   * The pattern is the health report's (audit 2.0 SEC-3): one route, admin
   * detail, a trimmed answer for everyone else.
   */
  @Get('verify')
  async verify(@Req() request: AuthenticatedRequest): Promise<ChainVerificationDto> {
    const spaceId = resolveSpaceId(request.principal);
    const confirmed = await this.db
      .select()
      .from(deletionReceipt)
      .where(and(eq(deletionReceipt.status, 'confirmed'), eq(deletionReceipt.spaceId, spaceId)));
    const pending = await this.db
      .select({ id: deletionReceipt.id, countsJson: deletionReceipt.countsJson })
      .from(deletionReceipt)
      .where(and(eq(deletionReceipt.status, 'pending'), eq(deletionReceipt.spaceId, spaceId)));

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

    if (request.principal.roles.includes(this.adminRole ?? 'admin')) {
      return { ...result, pending: pending.length };
    }
    const mine = (row: { countsJson: unknown }): boolean =>
      parseReceiptCounts(row.countsJson).requested_by === request.principal.userId;
    const myConfirmed = confirmed.filter(mine).length;
    return {
      ok: result.ok,
      // Instance-wide `ok` over the caller's own count: "the chain these N
      // receipts of yours sit in verifies". A broken chain verifies none of
      // them, which is the honest reading of a hash chain.
      verified: result.ok ? myConfirmed : 0,
      confirmed: myConfirmed,
      pending: pending.filter(mine).length,
    };
  }

  /** The caller's receipts in their current space, newest first
   * (enumeration time). */
  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<ReceiptListItem[]> {
    const rows = await this.db
      .select()
      .from(deletionReceipt)
      .where(
        and(
          eq(deletionReceipt.spaceId, resolveSpaceId(request.principal)),
          sql`counts_json->>'requested_by' = ${request.principal.userId}`,
        ),
      )
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
      throw userError.notFound('receipt.notFound', 'receipt {{id}} not found', { id });
    }
    // The anchor is computed within the RECEIPT'S OWN space: its chain is
    // the only chain it can reference (docs/features/spaces.md).
    const [alerting, chainTip] = await Promise.all([
      this.alertingReceiptIds(),
      this.chainTip(row.spaceId),
    ]);
    return {
      ...this.toListItem(row, alerting),
      countsJson: row.countsJson,
      hash: row.hash,
      prevHash: row.prevHash,
      signature: row.signature,
      signedAt: row.signedAt?.toISOString() ?? null,
      // stamp the ledger's chain tip onto the exported receipt as an
      // external anchor. A later verify must still contain this tip and show a
      // confirmed count ≥ this one — a dropped receipt moves the tip.
      chainTip,
    };
  }

  /**
   * The SPACE'S chain tip: the newest confirmed receipt in the space, the one
   * whose hash no other confirmed receipt in the space references as
   * prev_hash, plus the space's confirmed count. Exactly one tip exists on a
   * healthy chain (the saga refuses to extend past a fork), so more than one
   * reads as no tip rather than an arbitrary pick.
   */
  private async chainTip(
    spaceId: string,
  ): Promise<{ hash: string | null; confirmedCount: number }> {
    const confirmed = await this.db
      .select({ hash: deletionReceipt.hash, prevHash: deletionReceipt.prevHash })
      .from(deletionReceipt)
      .where(and(eq(deletionReceipt.status, 'confirmed'), eq(deletionReceipt.spaceId, spaceId)));
    const referenced = new Set(confirmed.map((r) => r.prevHash).filter((h): h is string => !!h));
    const tips = confirmed.filter((r) => r.hash && !referenced.has(r.hash));
    return { hash: tips.length === 1 ? tips[0]!.hash : null, confirmedCount: confirmed.length };
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
      chatMessagesRemoved: counts.chat_messages_removed ?? 0,
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
 * /api/integrity — the sweep's face in the System view (spec §11.1 step 4): last run,
 * result, and the open alert list. Alerts are never auto-cleared; they mean a
 * human must look.
 *
 * ADMIN-ONLY (audit 2.0 SEC-6). An alert's `detail` is an object key
 * (`{orgId}/{userId}/{scope}/…`), a memory id or a receipt id, so the list is
 * cross-user by construction — the same reason `/api/jobs` is admin-gated. The
 * only caller is the System page, which already refuses to render without the
 * admin role, so gating it here changes no working surface.
 */
@Controller('integrity')
@UseGuards(BearerAuthGuard, AdminGuard)
export class IntegrityController {
  constructor(private readonly sweep: IntegritySweep) {}

  @Get()
  async status(): Promise<IntegrityStatusDto> {
    const status = await this.sweep.status();
    return { ...status, alerts: await this.sweep.listAlerts() };
  }
}
