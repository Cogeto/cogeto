/** Audit-log reader DTOs (/spec §11.1; — closes the write-only-audit gap). */

export interface AuditEntryDto {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  detail: Record<string, unknown> | null;
  /** True when detail exists but belongs to another user's artifact — entries
   * are org-visible, detail is owner-only. */
  detailWithheld?: boolean;
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
  /** Narrow to one space's entries (docs/features/spaces.md section 4): the
   * audit trail stays ONE instance-level trail; the space is an attribute. */
  spaceId?: string;
  /** ISO timestamps bounding the range (inclusive from, exclusive to). */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}
