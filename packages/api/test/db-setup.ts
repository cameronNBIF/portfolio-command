/**
 * vitest `globalSetup`: prepares a dedicated test database, once per run.
 *
 * The round-trip test truncates every root table before it loads `demo.json`.
 * That is the right thing for it to do -- it is asserting that the contract
 * reproduces itself out of an empty schema -- and it is why the suite must
 * never point at the database a developer is working in. `testDatabaseUrl()`
 * derives `<database>_test` from `DATABASE_URL`, this creates and migrates it,
 * and `use-test-db.ts` redirects the workers onto it.
 *
 * Migrate and seed are shelled out rather than imported because both are
 * top-level scripts with their own connection handling, and a refactor of the
 * migration runner is not something a test-isolation fix should be smuggling
 * in. They are idempotent, so a re-run costs a few seconds and asserts nothing
 * has drifted.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { loadEnv, maintenanceUrl, testDatabaseUrl } from '@portfolio-command/db/env';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

export async function setup(): Promise<void> {
  loadEnv();
  const target = testDatabaseUrl();
  if (!target) return; // no DATABASE_URL: the suite skips, as it does in the no-services CI job

  const name = new URL(target).pathname.replace(/^\//, '');

  // `create database` cannot run inside a transaction and needs a connection to
  // some other database, so this goes through the maintenance database.
  const admin = new pg.Client({ connectionString: maintenanceUrl(target) });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [name]);
    if (!rowCount) {
      // Identifier, so it cannot be parameterised. The name is derived from our
      // own connection string rather than from user input.
      await admin.query(`create database "${name.replace(/"/g, '""')}"`);
      console.log(`[test-db] created ${name}`);
    }
  } finally {
    await admin.end();
  }

  // Node with the tsx loader, not `npm run`: npm resolves to `npm.cmd` on
  // Windows and `execFileSync` refuses to spawn a .cmd without a shell, while
  // `process.execPath` is the running node binary on every platform.
  const env = { ...process.env, DATABASE_URL: target };
  const run = (script: string) =>
    execFileSync(process.execPath, ['--import', 'tsx', path.join(repoRoot, script)], {
      cwd: repoRoot,
      env,
      stdio: 'pipe',
    });
  run('packages/db/src/migrate.ts');
  run('packages/db/src/seed.ts');
}
