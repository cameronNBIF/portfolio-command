import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Loads the repo-root .env (gitignored) regardless of which directory the
 * script is invoked from.
 *
 * EXPORTED SEPARATELY, and call it before reading any `process.env` at module
 * scope. It used to be reachable only through `requireDatabaseUrl()`, which
 * meant a module-level `const X = process.env.FOO` evaluated BEFORE the file
 * was loaded and silently saw undefined. That bit once: the seed's fund
 * identity fell back to its placeholder while the warning that should have
 * flagged it ran later, saw the real value, and stayed quiet.
 *
 * Repeat calls are harmless -- dotenv does not overwrite a variable that is
 * already set, so a real environment always wins over the file.
 */
export function loadEnv(): void {
  config({ path: path.resolve(here, '../../../.env') });
  config(); // also honour a .env in the current working directory, if any
}

/**
 * The database the test suite is allowed to destroy.
 *
 * The ADR-001 round-trip test TRUNCATES every root table and reloads
 * `demo.json`, which is correct for what it asserts and catastrophic for the
 * database it runs against: on the shared dev database it wipes the real
 * Affinity roster, five years of Visible KPI history and the entire A6
 * financial spine, and the only sign is that the dashboard suddenly shows the
 * prototype's fictional companies. That happened twice while A6 was being
 * built, which is what finally paid for this.
 *
 * `TEST_DATABASE_URL` wins if set. Otherwise the name is derived from
 * `DATABASE_URL` by appending `_test`, so the isolation is the default rather
 * than something a developer has to remember to configure -- and so CI, which
 * points `DATABASE_URL` at a throwaway container, gets it for free.
 *
 * Deriving rather than requiring is deliberate: a missing variable would make
 * the suite skip silently, and a silently skipped verification suite is worse
 * than a failing one.
 */
export function testDatabaseUrl(): string | null {
  loadEnv();
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL;
  if (!base) return null;
  const url = new URL(base);
  const name = url.pathname.replace(/^\//, '') || 'postgres';
  if (name.endsWith('_test')) return base;
  url.pathname = `/${name}_test`;
  return url.toString();
}

/** The maintenance connection on the same server, for `create database`. */
export function maintenanceUrl(target: string): string {
  const url = new URL(target);
  url.pathname = '/postgres';
  return url.toString();
}

/** Loads the environment, then returns DATABASE_URL or exits with a message. */
export function requireDatabaseUrl(): string {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env at the repo root and fill it in.');
    process.exit(1);
  }
  return url;
}
