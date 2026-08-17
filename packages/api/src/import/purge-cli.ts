/**
 * CLI wrapper around the fixture purge.
 *
 *   npm run fixture:purge              remove the fixture, keep everything else
 *   npm run fixture:purge -- --dry     say what it would remove, then roll back
 *   npm run fixture:purge -- path.json purge a document other than demo.json
 *
 * THE OPPOSITE OF `import:fixture` IN EVERY WAY THAT MATTERS. That command
 * truncates eight root tables and reloads; this one deletes only rows it can
 * prove the fixture wrote, and leaves the roster, the Visible history and the
 * generated financial spine untouched. It is the command for the state those
 * two produce together: a fixture loaded into an empty database, then a real
 * Affinity sync landing beside it rather than over it.
 *
 * `--dry` runs the whole thing inside a transaction and rolls back, the same
 * shape `db:generate --dry` uses. Prefer it first; the report is identical.
 *
 * The fixture stays in the repository and stays loadable. Removing it from a
 * database is not the same as giving it up, which is the whole reason this is a
 * purge rather than an edit to `demo.json`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import type { PortfolioExport } from '@portfolio-command/contract';
import { requireDatabaseUrl } from '@portfolio-command/db/env';
import { fundIdentity } from '@portfolio-command/db/fund-identity';

import { purgeFixture } from './purge-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = path.resolve(here, '../../../../docs/reference/demo.json');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const fileArg = args.find((a) => !a.startsWith('--'));

const target = fileArg ? path.resolve(fileArg) : DEFAULT_FIXTURE;
const doc = JSON.parse(readFileSync(target, 'utf8')) as PortfolioExport;

const connectionString = requireDatabaseUrl();
const dbName = new URL(connectionString).pathname.replace(/^\//, '');

// Said out loud, always, before anything is touched -- the same opening the
// import CLI makes, for the same reason.
console.log(`target database: ${dbName}${dry ? '  (dry run)' : ''}`);
console.log(`fixture:         ${path.relative(process.cwd(), target)}\n`);

const client = new pg.Client({ connectionString });
await client.connect();

try {
  await client.query('begin');
  await client.query('set local search_path = pc, public');

  const result = await purgeFixture(client, doc, fundIdentity());

  if (dry) await client.query('rollback');
  else await client.query('commit');

  if (result.batches.length === 0) {
    console.log('no __import__ ledger entry: this database has never loaded a contract document.');
    console.log('Rows are still matched on the roster discriminators below.\n');
  } else {
    console.log(`import batches found: ${result.batches.join(', ')}\n`);
  }

  const tables = Object.entries(result.removed).sort();
  if (tables.length === 0) {
    console.log('nothing to remove — no fixture rows found.\n');
  } else {
    const width = Math.max(...tables.map(([t]) => t.length));
    console.log(dry ? 'would remove:' : 'removed:');
    for (const [table, n] of tables) {
      console.log(`  ${table.padEnd(width)}  ${String(n).padStart(5)}`);
    }
    console.log('');
  }

  const fundLine = {
    restored: 'fund row restored to the seeded identity, financial fields cleared',
    'not-fixture': 'fund row left alone — it does not carry the fixture’s name',
    absent: 'no fund row present',
  }[result.fund];
  console.log(`${fundLine}\n`);

  if (result.skipped.length > 0) {
    console.log(`${result.skipped.length} row(s) deliberately left in place:\n`);
    for (const s of result.skipped) console.log(`  ${s.subject}\n    ${s.reason}`);
    console.log('');
  }

  console.log(
    `remaining: ${result.remaining.companies} companies, ` +
      `${result.remaining.pipelineDeals} pipeline deals` +
      (dry ? ' (unchanged — rolled back)' : ''),
  );

  if (!dry) {
    console.log('\nRegenerate types if anything downstream reads counts: npm run db:types');
  }
} catch (err) {
  await client.query('rollback').catch(() => undefined);
  console.error('\npurge failed, nothing was changed:\n');
  console.error(err);
  process.exit(1);
} finally {
  await client.end();
}
