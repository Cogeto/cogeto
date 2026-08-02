import { Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

/**
 * The database-side probes behind the aggregate health report (V2.0 item 3.6
 * part 2).
 *
 * The health controller used to run these itself from the composition root:
 * `SELECT 1`, the `graphile_worker` queue depth, `dead_letter`, and the
 * `cogeto_migrations` ledger — three tables and a schema that `infrastructure`
 * owns, in raw SQL, from outside it (recorded exceptions B9, B11, B18). The
 * queries are unchanged; they live with the tables now, and the health surface
 * asks for a verdict instead of writing SQL.
 *
 * **It keeps its own small pool, deliberately.** The controller had one, and
 * that is the property worth preserving: a saturated application pool must not
 * be able to make the health endpoint hang, because the one moment you need the
 * report is the moment the instance is under pressure. Two connections is
 * enough for four short reads. Owning a `Pool` is also why this lives in
 * `infrastructure` rather than in the module that serves the route: raw `pg` is
 * confined to the composition roots and the database module, so a domain module
 * cannot open a connection whose SQL no rule can see.
 */
@Injectable()
export class InstanceProbes implements OnApplicationShutdown {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 2 });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }

  /** Liveness of the database itself. Throws on failure; the caller times it. */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  /**
   * Queue depth, parked jobs, and graphile's own permanent-failure count.
   *
   * The last one is the backstop alert: our `dead_letter` write is best-effort
   * under database pressure (`queue.ts` retries it), so a job that exhausted its
   * retries without making it into `dead_letter` still shows up here.
   */
  async queueDepth(): Promise<{
    depth: number;
    deadLettered: number;
    permanentlyFailed: number;
  }> {
    const [jobs, parked, failed] = await Promise.all([
      this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM graphile_worker.jobs'),
      this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM dead_letter'),
      this.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM graphile_worker.jobs WHERE attempts >= max_attempts AND last_error IS NOT NULL',
      ),
    ]);
    return {
      depth: Number(jobs.rows[0]?.n ?? 0),
      deadLettered: Number(parked.rows[0]?.n ?? 0),
      permanentlyFailed: Number(failed.rows[0]?.n ?? 0),
    };
  }

  /** Applied migrations in order — the count and the latest name. */
  async migrations(): Promise<{ count: number; latest: string | undefined }> {
    const { rows } = await this.pool.query<{ name: string }>(
      'SELECT name FROM cogeto_migrations ORDER BY id',
    );
    return { count: rows.length, latest: rows[rows.length - 1]?.name };
  }

  /**
   * The first migration's `applied_at`: the closest thing to an install time.
   * A nightly job that has never run is not overdue until the instance is old
   * enough to have run it.
   */
  async installedAt(): Promise<Date | null> {
    const { rows } = await this.pool.query<{ installed_at: string | Date | null }>(
      'SELECT min(applied_at) AS installed_at FROM cogeto_migrations',
    );
    const raw = rows[0]?.installed_at;
    return raw ? new Date(raw) : null;
  }
}
