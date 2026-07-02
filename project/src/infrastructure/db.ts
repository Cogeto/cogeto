import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

/** The drizzle handle every module receives via DI. */
export type Db = NodePgDatabase;

/** The transaction handle drizzle passes to `db.transaction` callbacks. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Anything that can run queries: the root handle or an open transaction. */
export type DbOrTx = Db | Tx;

export function createDb(pool: Pool): Db {
  return drizzle(pool);
}

export const PG_POOL = Symbol('PG_POOL');
export const DRIZZLE = Symbol('DRIZZLE');
