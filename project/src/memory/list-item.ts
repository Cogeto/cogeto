import type { MemoryListItem } from '@cogeto/shared';
import type { MemoryRow } from './persistence/tables';

/**
 * Row → DTO for every surface that lists memories (dashboard, review, chat).
 * `ownerName` is filled by the caller (the controller resolves it through the
 * identity directory); the mapper is principal-agnostic and leaves it null.
 */
export function toListItem(row: MemoryRow): MemoryListItem {
  return {
    id: row.id,
    content: row.content,
    status: row.status,
    scope: row.scope,
    ownerId: row.ownerId,
    ownerName: null,
    sensitive: row.sensitive,
    entities: row.entities,
    kind: row.kind,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    supersededBy: row.supersededBy,
    validFrom: row.validFrom?.toISOString() ?? null,
    validUntil: row.validUntil?.toISOString() ?? null,
    temporalUnresolved: row.temporalUnresolved,
    createdAt: row.createdAt.toISOString(),
  };
}
