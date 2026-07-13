import { Global, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { createDb, DRIZZLE, PG_POOL } from './db';

@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Global database provider: one Pool + one drizzle handle per process,
 * registered once by the composition root. Modules inject DRIZZLE/PG_POOL;
 * which tables they may touch is governed by §A.1 rule 2 and the
 * dependency-cruiser persistence rule, not by connection ownership.
 */
@Global()
@Module({})
export class DatabaseModule {
  static register(options: { databaseUrl: string; poolMax?: number }): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: PG_POOL,
          // QS-38: an explicit, configurable pool ceiling (default 20 here in the
          // absence of a caller value — composition roots pass config.pgPoolMax).
          useFactory: () =>
            new Pool({ connectionString: options.databaseUrl, max: options.poolMax ?? 20 }),
        },
        { provide: DRIZZLE, useFactory: (pool: Pool) => createDb(pool), inject: [PG_POOL] },
        PoolLifecycle,
      ],
      exports: [PG_POOL, DRIZZLE],
    };
  }
}
