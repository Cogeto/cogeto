import type { MemoryListItem } from '@cogeto/shared';
import type { MemoryRow } from './persistence/tables';

/** Row → DTO for every surface that lists memories (dashboard, review, chat). */
export function toListItem(row: MemoryRow): MemoryListItem {
  return {
    id: row.id,
    content: row.content,
    status: row.status,
    scope: row.scope,
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
