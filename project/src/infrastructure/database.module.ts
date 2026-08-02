import { Global, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { createDb, DRIZZLE, PG_POOL } from './db';
import { DbModelEgressAudit, MODEL_EGRESS_AUDIT } from './model-egress-audit';
import { InstanceProbes } from './instance-probes';

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
 * which tables they may touch is governed by spec §15 rule 2 and the
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
          // an explicit, configurable pool ceiling (default 20 here in the
          // absence of a caller value — composition roots pass config.pgPoolMax).
          useFactory: () =>
            new Pool({ connectionString: options.databaseUrl, max: options.poolMax ?? 20 }),
        },
        { provide: DRIZZLE, useFactory: (pool: Pool) => createDb(pool), inject: [PG_POOL] },
        PoolLifecycle,
        // The health report's database probes, on their own two-connection pool
        // so a saturated application pool cannot make the report hang.
        { provide: InstanceProbes, useFactory: () => new InstanceProbes(options.databaseUrl) },
        // The model-egress recorder (V2.0 item 3.7). It needs the Drizzle handle
        // and nothing else, and the trail's table is infrastructure's, so it
        // belongs with the handle rather than in the limits module: an egress
        // record is not a cap. The gateway seam injects the token optionally, so
        // a root without a database still boots.
        {
          provide: MODEL_EGRESS_AUDIT,
          useFactory: (db: ReturnType<typeof createDb>) => new DbModelEgressAudit(db),
          inject: [DRIZZLE],
        },
      ],
      exports: [PG_POOL, DRIZZLE, InstanceProbes, MODEL_EGRESS_AUDIT],
    };
  }
}
