import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Loads the repo-root .env (gitignored) regardless of which directory the
 * script is invoked from, then returns DATABASE_URL or exits with a message.
 */
export function requireDatabaseUrl(): string {
  config({ path: path.resolve(here, '../../../.env') });
  config(); // also honour a .env in the current working directory, if any
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env at the repo root and fill it in.');
    process.exit(1);
  }
  return url;
}
