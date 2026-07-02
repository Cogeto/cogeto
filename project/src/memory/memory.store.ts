import { Injectable, NotImplementedException } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';

/**
 * Search primitives over memory storage (decision 0003 ruling 2).
 *
 * Every primitive REQUIRES a Principal and applies the scope and sensitivity
 * gates internally — an unscoped query is unrepresentable in this type system.
 * `retrieval` composes these (fusion, status multipliers); it never touches a
 * client or a table.
 */
export interface MemorySearchHit {
  memoryId: string;
  /** Normalized to [0,1], higher = better (research: memory-architecture §6). */
  score: number;
}

export interface SearchOptions {
  topK: number;
  /** Explicit per-query opt-in; sensitive hits are owner-only (decision 0003 ruling 3). */
  includeSensitive?: boolean;
}

@Injectable()
export class MemoryStore {
  vectorSearch(
    _principal: Principal,
    _embedding: number[],
    _opts: SearchOptions,
  ): Promise<MemorySearchHit[]> {
    throw new NotImplementedException(
      'S1-B: implemented with migration 0001 and the Qdrant adapter',
    );
  }

  fullTextSearch(
    _principal: Principal,
    _query: string,
    _opts: SearchOptions,
  ): Promise<MemorySearchHit[]> {
    throw new NotImplementedException('S1-B: implemented with migration 0001 (Postgres FTS)');
  }

  entitySearch(
    _principal: Principal,
    _entity: string,
    _opts: SearchOptions,
  ): Promise<MemorySearchHit[]> {
    throw new NotImplementedException('S1-B: implemented with migration 0001 (trigram index)');
  }
}
