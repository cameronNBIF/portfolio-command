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
