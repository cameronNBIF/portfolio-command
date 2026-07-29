/**
 * Plain-SQL migration runner. Forward-only, deliberately (ADR-018 ethos:
 * a bad migration is corrected by the next one, not rolled back).
 *
 * - Applies packages/db/migrations/NNNN_name.sql in filename order.
 * - Each migration runs in one transaction.
 * - Applied versions are recorded in public.schema_migrations with a
 *   sha-256 checksum; a checksum mismatch on an applied file aborts,
 *   because it means history was edited rather than extended.
 * - schema_migrations lives in public: schema pc does not exist until
 *   migration 0001 creates it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { requireDatabaseUrl } from './env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../migrations');

// Line endings are normalised before hashing so a git autocrlf change on
// Windows never reads as a tampered migration.
const checksumOf = (sql: string) =>
  createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

const client = new pg.Client({ connectionString: requireDatabaseUrl() });
await client.connect();

try {
  await client.query(`
    create table if not exists public.schema_migrations (
      version    int primary key,
      name       text not null,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )`);

  // One runner at a time; a second concurrent invocation waits here.
  await client.query('select pg_advisory_lock(727701)');

  const applied = new Map<number, { name: string; checksum: string }>(
    (await client.query('select version, name, checksum from public.schema_migrations')).rows.map(
      (r: { version: number; name: string; checksum: string }) => [r.version, r],
    ),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  let appliedCount = 0;
  for (const file of files) {
    const version = parseInt(file.slice(0, 4), 10);
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    const checksum = checksumOf(sql);

    const prior = applied.get(version);
    if (prior) {
      if (prior.checksum !== checksum) {
        throw new Error(
          `${file} has changed since it was applied (checksum mismatch). ` +
            'Migrations are append-only: write a new migration instead of editing an applied one.',
        );
      }
      continue;
    }

    process.stdout.write(`applying ${file} ... `);
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query(
        'insert into public.schema_migrations (version, name, checksum) values ($1, $2, $3)',
        [version, file, checksum],
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      console.log('FAILED');
      throw err;
    }
    console.log('done');
    appliedCount++;
  }

  console.log(
    appliedCount === 0
      ? `up to date (${files.length} migration${files.length === 1 ? '' : 's'} already applied)`
      : `applied ${appliedCount} migration${appliedCount === 1 ? '' : 's'}`,
  );
} finally {
  await client.end();
}
