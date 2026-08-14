/**
 * vitest `setupFiles`: points this worker at the test database.
 *
 * Runs inside the worker process, before the test module is imported, so every
 * later reader of `DATABASE_URL` -- the round-trip test's own `pg.Client` and
 * the lazily-constructed pool in `src/db.ts` alike -- sees the test database
 * and nothing has to be threaded through by hand.
 *
 * A `globalSetup` cannot do this: it runs in the main process and its
 * `process.env` mutations do not reliably reach the workers.
 */
import { loadEnv, testDatabaseUrl } from '@portfolio-command/db/env';

loadEnv();
const target = testDatabaseUrl();
if (target) process.env.DATABASE_URL = target;
