/** Deletion receipt DTOs (spec §11.1). */

/** POST-side response of DELETE /api/sources/:type/:id — the saga's handle. */
export interface DeletionRequestedDto {
  receiptId: string;
}

/** GET /api/sources/:type/:id/impact — the confirm dialog's exact numbers. */
export interface DeletionPreviewDto {
  sourceType: string;
  sourceId: string;
  memoryCount: number;
  objectCount: number;
  /** Chat messages a conversation deletion removes; absent otherwise. */
  messageCount?: number;
  /** Enumerated memories the user explicitly approved — deleted knowingly. */
  userApprovedCount?: number;
}

/** GET /api/receipts/verify — walk of the full hash chain (spec §11.1). */
export interface ChainVerificationDto {
  ok: boolean;
  /** Receipts that verified, in chain order. */
  verified: number;
  /** Total confirmed receipts. */
  confirmed: number;
  /** Receipts still awaiting external deletion (worker in flight or parked). */
  pending: number;
  /** First failure, when !ok. */
  error?: string;
}

/** One row of the Forgotten ledger (GET /api/receipts, newest first). */
export interface ReceiptListItem {
  id: string;
  sourceType: string;
  sourceId: string;
  status: 'pending' | 'confirmed';
  /** The nightly sweep flagged this receipt (integrity_alert rows exist). */
  alerting: boolean;
  memoryCount: number;
  objectCount: number;
  /** Assistant chat answers redacted because they cited the erased memories
   *; 0 on pre-0025 receipts. */
  chatMessagesRedacted: number;
  /** Chat messages removed with a conversation source; 0 otherwise. */
  chatMessagesRemoved: number;
  /** Enumeration time — when the deletion was requested. */
  requestedAt: string;
  confirmedAt: string | null;
}

/**
 * The chain tip carried on every exported receipt — a cheap EXTERNAL
 * ANCHOR. Recording the tip hash + confirmed count at export time lets anyone
 * later prove no confirmed receipt was quietly dropped from the ledger: the tip
 * they hold must still appear in (and the count must not exceed) a fresh
 * GET /api/receipts/verify. Tamper that removes a receipt changes the tip.
 */
export interface ChainTipAnchor {
  /** Hash of the newest confirmed receipt (the chain head); null if none yet. */
  hash: string | null;
  /** Number of confirmed receipts in the ledger at export time. */
  confirmedCount: number;
}

/** GET /api/receipts/:id — the full artifact behind a ledger row. */
export interface ReceiptDetailDto extends ReceiptListItem {
  countsJson: unknown;
  /** Chain fields — null until the receipt is confirmed. */
  hash: string | null;
  prevHash: string | null;
  signature: string | null;
  signedAt: string | null;
  /** The ledger's chain tip at export time — the external anchor. */
  chainTip: ChainTipAnchor;
}

/** One sweep discrepancy (spec §11.1 step 4) — permanent until investigated. */
export interface IntegrityAlertDto {
  id: string;
  receiptId: string | null;
  kind: string;
  detail: string;
  detectedAt: string;
}

/** GET /api/integrity — last sweep + open alerts for the System view. */
export interface IntegrityStatusDto {
  lastSweepAt: string | null;
  lastReport: {
    receiptsChecked: number;
    identifiersChecked: number;
    newAlerts: number;
    openAlerts: number;
    chainOk: boolean;
    chainError?: string;
  } | null;
  openAlerts: number;
  alerts: IntegrityAlertDto[];
}
