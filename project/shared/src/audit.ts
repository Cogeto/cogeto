/** Audit-log reader DTOs (§A.8/§B.1; O1-C — closes the write-only-audit gap). */

export interface AuditEntryDto {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

/** GET /api/audit envelope: `total` counts everything under the filters. */
export interface AuditPage {
  items: AuditEntryDto[];
  total: number;
}

export interface AuditQuery {
  actor?: string;
  action?: string;
  entityType?: string;
  /** ISO timestamps bounding the range (inclusive from, exclusive to). */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}
