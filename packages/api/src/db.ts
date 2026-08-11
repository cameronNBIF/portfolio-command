/**
 * The database connection.
 *
 * Kysely over `pg`, per A0.1: a query builder rather than an ORM, so the
 * hand-written SQL the schema depends on -- views, lateral joins, set-returning
 * functions -- is expressed directly instead of fought. The reads in `read/`
 * use `sql` templates for exactly that reason; Kysely supplies the pool, the
 * parameterisation and the row typing.
 *
 * `numeric` arrives as a STRING and that is deliberate (ADR-008). Nothing here
 * parses it. `units.ts` is the only place a stored dollar becomes a number.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { DB } from '@portfolio-command/db/generated';

let pool: pg.Pool | null = null;
let instance: Kysely<DB> | null = null;

/**
 * Process-wide connection, created on first use.
 *
 * Next.js route handlers run per request; a pool per request would exhaust
 * Postgres connections under any real load, so the pool is module-scoped and
 * outlives the request.
 */
export function db(connectionString?: string): Kysely<DB> {
  if (instance) return instance;

  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env at the repo root.');
  }

  pool = new pg.Pool({
    connectionString: url,
    max: 10,
    // Every query resolves unqualified names against the pc schema, matching
    // migrate.ts and seed.ts. Set on connect so it survives pool recycling.
    options: '-c search_path=pc,public',
  });

  instance = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return instance;
}

/** Closes the pool. For test teardown and CLI scripts; a server never calls it. */
export async function closeDb(): Promise<void> {
  if (instance) await instance.destroy();
  instance = null;
  pool = null;
}
