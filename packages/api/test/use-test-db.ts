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

/**
 * Checked again AT THE POINT OF USE, by every suite that destroys what it finds.
 *
 * THE REDIRECT ABOVE IS ONLY APPLIED IF THIS FILE RUNS AT ALL, and that is a
 * property of how vitest was invoked, not of anything in this package. A8.2
 * found `npx vitest run -w packages/api` still running from 13 August: `-w` is
 * vitest's WATCH flag, not npm's workspace flag, so the command meant "watch the
 * whole repo, and treat packages/api as a filter" -- executed from the repo
 * root, where there is no `vitest.config.ts`, so `setupFiles` never loaded and
 * every re-run on every file change went at the DEVELOPMENT database and
 * truncated it. Four days of that, and it is the likeliest explanation for the
 * A8 wipes that were recorded as unexplained and blamed on the import CLI.
 *
 * A setup file cannot defend against its own absence. This runs inside the test,
 * immediately before it connects, so it fires however the redirect came to be
 * missing -- wrong invocation, wrong cwd, a config that stopped being found --
 * and turns a silently destroyed database into a failed assertion.
 */
export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (!url) return; // no database configured: the suite skips, as it does in CI
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `This suite truncates what it finds and is pointed at "${name}", which is not a ` +
        'test database. Refusing to run. Expected a name ending in "_test" — see ' +
        'testDatabaseUrl() in packages/db/src/env.ts.',
    );
  }
}
